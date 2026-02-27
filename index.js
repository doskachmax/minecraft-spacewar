const steamworks = require('steamworks.js');
const net = require('net');

const args = process.argv.slice(2);
const mode = args[0];

if (mode !== 'host' && mode !== 'client') {
    console.error('Usage: node index.js <host|client> [targetSteamId]');
    process.exit(1);
}

const client = steamworks.init(480);
const localSteamId = client.localplayer.getSteamId().steamId64;

console.log(`Steamworks initialized. Local Steam ID: ${localSteamId}`);

const PACKET_DATA = 0;
const PACKET_CONNECT = 1;
const PACKET_DISCONNECT = 2;

function encodePacket(type, connId, payload) {
    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeUInt32LE(connId, 1);
    if (payload) {
        return Buffer.concat([header, payload]);
    }
    return header;
}

if (mode === 'host') {
    console.log('Running in HOST mode.');
    console.log('Listening for Steam P2P connections...');

    // Map of connId + steamId -> net.Socket
    const sockets = new Map();

    client.callback.register(6, (req) => {
        console.log(`P2P Session request from ${req.remote}. Accepting.`);
        client.networking.acceptP2PSession(req.remote);
    });

    setInterval(() => {
        let size;
        while ((size = client.networking.isP2PPacketAvailable(0)) > 0) {
            let packet;
            try {
                packet = client.networking.readP2PPacket(size, 0);
            } catch (err) {
                console.error(`[Host] Ignored read packet error for size ${size}: ${err.message}`);
                continue;
            }
            const remoteSteamId = packet.steamId.steamId64;
            const data = packet.data;

            if (data.length < 5) continue;

            const type = data.readUInt8(0);
            const connId = data.readUInt32LE(1);
            const payload = data.slice(5);

            const socketKey = `${remoteSteamId}-${connId}`;

            if (type === PACKET_CONNECT) {
                console.log(`[Host] Client ${remoteSteamId} requests connection ${connId} to Minecraft server...`);
                const socket = new net.Socket();

                socket.connect(25565, '127.0.0.1', () => {
                    console.log(`[Host] Connected ${socketKey} to local Minecraft server.`);
                    client.networking.sendP2PPacket(remoteSteamId, 2, encodePacket(PACKET_CONNECT, connId, null));
                });

                socket.on('data', (sockData) => {
                    client.networking.sendP2PPacket(remoteSteamId, 2, encodePacket(PACKET_DATA, connId, sockData));
                });

                socket.on('close', () => {
                    console.log(`[Host] Local Minecraft server closed connection ${socketKey}.`);
                    client.networking.sendP2PPacket(remoteSteamId, 2, encodePacket(PACKET_DISCONNECT, connId, null));
                    sockets.delete(socketKey);
                });

                socket.on('error', (err) => {
                    console.error(`[Host] Minecraft socket error for ${socketKey}:`, err.message);
                    socket.destroy();
                });

                sockets.set(socketKey, socket);
            } else if (type === PACKET_DATA) {
                const socket = sockets.get(socketKey);
                if (socket) {
                    socket.write(payload);
                }
            } else if (type === PACKET_DISCONNECT) {
                console.log(`[Host] Client ${remoteSteamId} closed connection ${connId}.`);
                const socket = sockets.get(socketKey);
                if (socket) {
                    socket.destroy();
                    sockets.delete(socketKey);
                }
            }
        }
    }, 10);

} else if (mode === 'client') {
    const targetSteamIdStr = args[1];
    if (!targetSteamIdStr) {
        console.error('Usage: node index.js client <targetSteamId>');
        process.exit(1);
    }

    const targetSteamId = BigInt(targetSteamIdStr);

    console.log(`Running in CLIENT mode. Target Steam ID: ${targetSteamId}`);

    let nextConnId = 1;
    const clientSockets = new Map();

    const server = net.createServer((socket) => {
        const connId = nextConnId++;
        clientSockets.set(connId, socket);

        console.log(`[Client] New local connection ${connId}.`);
        client.networking.sendP2PPacket(targetSteamId, 2, encodePacket(PACKET_CONNECT, connId, null));

        socket.on('data', (data) => {
            client.networking.sendP2PPacket(targetSteamId, 2, encodePacket(PACKET_DATA, connId, data));
        });

        socket.on('close', () => {
            console.log(`[Client] Local connection ${connId} closed.`);
            client.networking.sendP2PPacket(targetSteamId, 2, encodePacket(PACKET_DISCONNECT, connId, null));
            clientSockets.delete(connId);
        });

        socket.on('error', (err) => {
            console.error(`[Client] Local socket error ${connId}:`, err.message);
            socket.destroy();
        });
    });

    server.listen(25565, '127.0.0.1', () => {
        console.log(`[Client] Listening locally on 127.0.0.1:25565`);
    });

    setInterval(() => {
        let size;
        while ((size = client.networking.isP2PPacketAvailable(0)) > 0) {
            let packet;
            try {
                packet = client.networking.readP2PPacket(size, 0);
            } catch (err) {
                console.error(`[Client] Ignored read packet error for size ${size}: ${err.message}`);
                continue;
            }
            const data = packet.data;

            if (data.length < 5) continue;

            const type = data.readUInt8(0);
            const connId = data.readUInt32LE(1);
            const payload = data.slice(5);

            const socket = clientSockets.get(connId);
            if (!socket) continue;

            if (type === PACKET_DATA) {
                socket.write(payload);
            } else if (type === PACKET_DISCONNECT) {
                console.log(`[Client] Host closed connection ${connId}.`);
                socket.destroy();
                clientSockets.delete(connId);
            } else if (type === PACKET_CONNECT) {
                console.log(`[Client] Host acknowledged connection ${connId}.`);
            }
        }
    }, 10);
}
