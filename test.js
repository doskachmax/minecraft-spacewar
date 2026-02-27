const steamworks = require('steamworks.js');
const client = steamworks.init(480);
console.log(Object.keys(client));
console.log(Object.keys(client.callback || {}));
