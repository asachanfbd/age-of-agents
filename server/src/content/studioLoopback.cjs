'use strict';
// Preloaded into Remotion Studio (`NODE_OPTIONS=--require`). Studio binds every network interface and has no host option, so every
// server it opens is bound to 127.0.0.1 instead: Studio is reachable from this machine only.
const net = require('node:net');

const LOOPBACK = '127.0.0.1';
const listen = net.Server.prototype.listen;

net.Server.prototype.listen = function listenOnLoopback(...args) {
  const [first] = args;
  if (first === undefined || typeof first === 'function') {
    // listen(callback?): a random port
    args.unshift(0, LOOPBACK);
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    // listen(port, host?, backlog?, callback?)
    if (typeof args[1] === 'string') args[1] = LOOPBACK;
    else args.splice(1, 0, LOOPBACK);
  } else if (first && typeof first === 'object' && first.path === undefined && first.fd === undefined && first.handle === undefined && first._handle === undefined) {
    args[0] = { ...first, host: LOOPBACK };
  }
  return listen.apply(this, args);
};
