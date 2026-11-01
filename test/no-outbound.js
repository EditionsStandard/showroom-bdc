'use strict';
// Integration servers may talk only to loopback. Fail closed if a future test
// accidentally configures a provider, remote image, mailer or tracking service.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const opts = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof opts === 'object' ? opts.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host && !['localhost','127.0.0.1','::1'].includes(host)) throw new Error('Test outbound connection blocked');
  return originalConnect.apply(this,args);
};
const originalFetch = global.fetch;
global.fetch = (url, ...args) => {
  if (!['localhost','127.0.0.1','[::1]'].includes(new URL(typeof url === 'string' || url instanceof URL ? url : url.url).hostname))
    return Promise.reject(new Error('Test outbound fetch blocked'));
  return originalFetch(url,...args);
};
