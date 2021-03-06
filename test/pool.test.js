/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_tape = require('tape');
const mod_sinon = require('sinon');
const mod_events = require('events');
const mod_util = require('util');
const mod_assert = require('assert-plus');
const mod_bunyan = require('bunyan');

const mod_pool = require('../lib/pool');
const mod_resolver = require('../lib/resolver');

var sandbox;
var connections = [];
var resolver;
var log = mod_bunyan.createLogger({
	name: 'pool-test',
	level: process.env.LOGLEVEL || 'debug'
});
var recovery = {
	default: {timeout: 1000, retries: 3, delay: 100 }
};

function DummyResolver() {
	resolver = this;
	this.state = 'stopped';
	mod_events.EventEmitter.call(this);
}
mod_util.inherits(DummyResolver, mod_events.EventEmitter);
DummyResolver.prototype.start = function () {
	this.state = 'running';
};
DummyResolver.prototype.stop = function () {
	this.state = 'stopped';
};

function DummyConnection(backend) {
	connections.push(this);
	this.backend = backend.key;
	this.backendInfo = backend;
	this.refd = true;
	this.connected = false;
	this.dead = false;
	mod_events.EventEmitter.call(this);
}
mod_util.inherits(DummyConnection, mod_events.EventEmitter);
DummyConnection.prototype.connect = function () {
	mod_assert.ok(this.dead === false);
	mod_assert.ok(this.connected === false);
	this.connected = true;
	this.emit('connect');
};
DummyConnection.prototype.unref = function () {
	this.refd = false;
};
DummyConnection.prototype.ref = function () {
	this.refd = true;
};
DummyConnection.prototype.destroy = function () {
	var idx = connections.indexOf(this);
	mod_assert.ok(idx !== -1);
	connections.splice(idx, 1);
	this.connected = false;
	this.dead = true;
};

mod_tape.test('setup sandbox', function (t) {
	sandbox = mod_sinon.sandbox.create();
	sandbox.stub(mod_resolver, 'Resolver', DummyResolver);
	t.end();
});

mod_tape.test('empty pool', function (t) {
	connections = [];
	resolver = undefined;

	var pool = new mod_pool.ConnectionPool({
		log: log,
		domain: 'foobar',
		constructor: function (backend) {
			return (new DummyConnection(backend));
		},
		recovery: recovery,
		spares: 2,
		maximum: 4
	});
	t.ok(resolver);
	t.strictEqual(resolver.state, 'running');
	t.strictEqual(connections.length, 0);

	t.throws(function () {
		pool.claimSync();
	});

	pool.claim({timeout: 100}, function (err) {
		t.ok(err);
		t.ok(err.message.match(/timed out/i));
		t.end();
	});
});

mod_tape.test('pool with one backend, claimSync', function (t) {
	connections = [];
	resolver = undefined;

	var pool = new mod_pool.ConnectionPool({
		log: log,
		domain: 'foobar',
		spares: 2,
		maximum: 3,
		constructor: function (backend) {
			return (new DummyConnection(backend));
		},
		recovery: recovery
	});
	t.ok(resolver);

	resolver.emit('added', 'b1', {});
	setImmediate(function () {
		t.equal(connections.length, 2);
		t.strictEqual(connections[0].backend, 'b1');
		t.strictEqual(connections[1].backend, 'b1');

		/* The connections haven't emitted connect() yet. */
		t.throws(function () {
			pool.claimSync();
		});
		connections.forEach(function (c) {
			t.strictEqual(c.refd, true);
		});

		connections[0].connect();
		connections[1].connect();

		connections.forEach(function (c) {
			t.strictEqual(c.refd, false);
		});

		var ret = pool.claimSync();
		t.ok(typeof (ret) === 'object');
		t.ok(ret.handle);
		t.strictEqual(ret.connection, connections[0]);
		t.strictEqual(connections[0].refd, true);

		var ret2 = pool.claimSync();
		t.ok(typeof (ret2) === 'object');
		t.strictEqual(ret2.connection, connections[1]);

		t.throws(function () {
			pool.claimSync();
		});

		t.end();
	});
});

mod_tape.test('async claim can expand up to max', function (t) {
	connections = [];
	resolver = undefined;

	var pool = new mod_pool.ConnectionPool({
		log: log,
		domain: 'foobar',
		spares: 0,
		maximum: 2,
		constructor: function (backend) {
			return (new DummyConnection(backend));
		},
		recovery: recovery
	});
	t.ok(resolver);

	resolver.emit('added', 'b1', {});
	resolver.emit('added', 'b2', {});
	setImmediate(function () {
		t.equal(connections.length, 0);

		pool.claim(function (err, handle, conn) {
			t.error(err);
			var b1 = conn.backend;
			t.ok(['b1', 'b2'].indexOf(b1) !== -1);

			pool.claim(function (err2, handle2, conn2) {
				t.error(err2);
				var b2 = conn2.backend;
				t.ok(['b1', 'b2'].indexOf(b2) !== -1);
				t.notStrictEqual(b1, b2);

				pool.claim({timeout: 100}, function (err3) {
					t.ok(err3);
					t.end();
				});
			});

			setImmediate(function () {
				t.equal(connections.length, 2);
				connections[1].connect();
			});
		});

		setImmediate(function () {
			t.equal(connections.length, 1);
			connections[0].connect();
		});
	});
});

mod_tape.test('spares are evenly balanced', function (t) {
	connections = [];
	resolver = undefined;

	var pool = new mod_pool.ConnectionPool({
		log: log,
		domain: 'foobar',
		spares: 4,
		maximum: 4,
		constructor: function (backend) {
			return (new DummyConnection(backend));
		},
		recovery: recovery
	});
	t.ok(resolver);
	t.strictEqual(pool.p_resolver, resolver);

	resolver.emit('added', 'b1', {});
	resolver.emit('added', 'b2', {});
	setImmediate(function () {
		t.equal(connections.length, 4);
		var bs = connections.map(function (c) { return (c.backend); });
		t.deepEqual(bs.sort(), ['b1', 'b1', 'b2', 'b2']);

		connections.forEach(function (c) { c.connect(); });

		resolver.emit('added', 'b3', {});
		resolver.emit('added', 'b4', {});

		setImmediate(function () {
			connections.forEach(function (c) {
				if (!c.connected)
					c.connect();
			});

			t.equal(connections.length, 4);
			var bs2 = connections.map(
			    function (c) { return (c.backend); });
			t.deepEqual(bs2.sort(), ['b1', 'b2', 'b3', 'b4']);

			t.end();
		});
	});
});

mod_tape.test('error while claimed', function (t) {
	connections = [];
	resolver = undefined;

	var pool = new mod_pool.ConnectionPool({
		log: log,
		domain: 'foobar',
		spares: 1,
		maximum: 1,
		constructor: function (backend) {
			return (new DummyConnection(backend));
		},
		recovery: recovery
	});
	t.ok(resolver);

	resolver.emit('added', 'b1', {});
	setImmediate(function () {
		t.equal(connections.length, 1);
		connections[0].connect();

		pool.claim(function (err, handle, conn) {
			t.strictEqual(conn, connections[0]);
			conn.emit('error', new Error('testing'));
			handle.release();

			setTimeout(function () {
				t.ok(conn.dead);
				t.equal(connections.length, 1);
				connections[0].connect();

				t.end();
			}, 500);
		});
	});
});

mod_tape.test('cleanup sandbox', function (t) {
	sandbox.restore();
	t.end();
});
