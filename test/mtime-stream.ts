import type Docker from 'dockerode';
import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import DockerGC from '../build/index';

// A fake docker that hands out controllable event streams, so that the mtime
// stream lifecycle can be tested without a real docker engine
const createFakeDocker = () => {
	const fake = {
		eventStreams: [] as Readable[],
		listImagesError: undefined as Error | undefined,
		listImagesGate: undefined as Promise<void> | undefined,
		getEvents: () => {
			const stream = new Readable({
				read() {
					// noop
				},
			});
			fake.eventStreams.push(stream);
			return Promise.resolve(stream);
		},
		listImages: async () => {
			await fake.listImagesGate;
			if (fake.listImagesError != null) {
				throw fake.listImagesError;
			}
			return [];
		},
	};
	return fake;
};

// A fake engine over HTTP, for testing `setDocker`, which creates its own
// dockerode instance
const startFakeEngine = async ({
	pingStatus = 200,
	pingGate,
	imagesGate,
}: {
	pingStatus?: number;
	pingGate?: Promise<void>;
	imagesGate?: Promise<void>;
} = {}) => {
	const engine = {
		pings: 0,
		eventsRequests: 0,
		openEventsRequests: 0,
		dockerOpts: {} as Docker.DockerOptions,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			}),
	};
	const server = http.createServer((req, res) => {
		void (async () => {
			const url = req.url ?? '';
			if (url.includes('/_ping')) {
				engine.pings++;
				await pingGate;
				res.writeHead(pingStatus, { 'Content-Type': 'text/plain' });
				res.end(pingStatus === 200 ? 'OK' : 'error');
			} else if (url.includes('/images/json')) {
				await imagesGate;
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('[]');
			} else if (url.includes('/events')) {
				engine.eventsRequests++;
				engine.openEventsRequests++;
				res.on('close', () => {
					engine.openEventsRequests--;
				});
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.flushHeaders();
			} else {
				res.writeHead(404);
				res.end();
			}
		})();
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	engine.dockerOpts = { host: '127.0.0.1', port };
	return engine;
};

const createGC = (docker: ReturnType<typeof createFakeDocker>) => {
	const gc = new DockerGC();
	gc.minDelayMs = 5;
	gc.maxDelayMs = 10;
	Object.assign(gc, { docker: docker as unknown as Docker });
	return gc;
};

const getMtimes = (gc: DockerGC) =>
	// @ts-expect-error currentMtimes is private
	gc.currentMtimes as Map<string, number>;

describe('mtime stream lifecycle', function () {
	let consoleError: typeof console.error;
	before(function () {
		// The lifecycle logs expected errors, keep the test output clean
		consoleError = console.error;
		console.error = () => {
			// noop
		};
	});
	after(function () {
		console.error = consoleError;
	});

	it('should destroy the docker events request when the mtime stream is destroyed', async function () {
		const docker = createFakeDocker();
		const gc = createGC(docker);
		await gc.setupMtimeStream();
		gc.destroyMtimeStream();
		await setTimeout(10);
		expect(docker.eventStreams).to.have.length(1);
		expect(docker.eventStreams[0].destroyed).to.equal(true);
	});

	it('should restart the mtime stream when the events request ends', async function () {
		const docker = createFakeDocker();
		const gc = createGC(docker);
		await gc.setupMtimeStream();
		docker.eventStreams[0].push(null);
		await setTimeout(50);
		expect(docker.eventStreams).to.have.length(2);

		// Daemons before API v1.52 send both the legacy and current fields
		docker.eventStreams[1].push(
			JSON.stringify({
				status: 'pull',
				id: 'foo:1',
				Type: 'image',
				Action: 'pull',
				Actor: { ID: 'foo:1', Attributes: {} },
				time: 5,
			}) + '\n',
		);
		await setTimeout(10);
		expect(getMtimes(gc).get('foo:1')).to.equal(5);
		gc.destroyMtimeStream();
	});

	it('should restart the mtime stream when the events request errors', async function () {
		const docker = createFakeDocker();
		const gc = createGC(docker);
		await gc.setupMtimeStream();
		docker.eventStreams[0].destroy(new Error('boom'));
		await setTimeout(50);
		expect(docker.eventStreams).to.have.length(2);
		gc.destroyMtimeStream();
		await setTimeout(10);
		expect(docker.eventStreams[1].destroyed).to.equal(true);
	});

	it('should not restart the mtime stream after it has been destroyed', async function () {
		const docker = createFakeDocker();
		const gc = createGC(docker);
		await gc.setupMtimeStream();
		docker.eventStreams[0].destroy(new Error('boom'));
		// Let the stream fail and schedule a restart, then destroy before it fires
		await setTimeout(1);
		gc.destroyMtimeStream();
		await setTimeout(50);
		expect(docker.eventStreams).to.have.length(1);
	});

	it('should set up a new stream when set up again whilst a destroyed setup is still in progress', async function () {
		const docker = createFakeDocker();
		let releaseListImages!: () => void;
		const listImagesGate = new Promise<void>((resolve) => {
			releaseListImages = resolve;
		});
		docker.listImagesGate = listImagesGate;
		const gc = createGC(docker);
		const destroyedSetup = gc.setupMtimeStream();
		gc.destroyMtimeStream();
		const setup = gc.setupMtimeStream();
		releaseListImages();
		await Promise.all([destroyedSetup, setup]);
		await setTimeout(10);
		expect(docker.eventStreams).to.have.length(2);
		expect(docker.eventStreams[0].destroyed).to.equal(true);
		expect(docker.eventStreams[1].destroyed).to.equal(false);
		gc.destroyMtimeStream();
	});

	it('should not keep a stream that was destroyed whilst being set up', async function () {
		const docker = createFakeDocker();
		const gc = createGC(docker);
		const setup = gc.setupMtimeStream();
		gc.destroyMtimeStream();
		await setup;
		await setTimeout(10);
		expect(docker.eventStreams).to.have.length(1);
		expect(docker.eventStreams[0].destroyed).to.equal(true);
	});

	it('should only create one stream for concurrent setup calls', async function () {
		const docker = createFakeDocker();
		const gc = createGC(docker);
		await Promise.all([
			gc.setupMtimeStream(),
			gc.setupMtimeStream(),
			gc.setupMtimeStream(),
		]);
		expect(docker.eventStreams).to.have.length(1);
		gc.destroyMtimeStream();
	});

	it('should not leave the events request open if listing images fails', async function () {
		const docker = createFakeDocker();
		docker.listImagesError = new Error('listImages failed');
		const gc = createGC(docker);
		let error: Error | undefined;
		try {
			await gc.setupMtimeStream();
		} catch (err: any) {
			error = err;
		}
		expect(error).to.have.property('message', 'listImages failed');
		expect(docker.eventStreams).to.have.length(1);
		expect(docker.eventStreams[0].destroyed).to.equal(true);
		gc.destroyMtimeStream();
	});

	describe('setDocker', function () {
		const engines: Array<Awaited<ReturnType<typeof startFakeEngine>>> = [];
		const startEngine = async (
			opts?: Parameters<typeof startFakeEngine>[0],
		) => {
			const engine = await startFakeEngine(opts);
			engines.push(engine);
			return engine;
		};
		afterEach(async function () {
			await Promise.all(engines.splice(0).map((engine) => engine.close()));
		});
		// The engine sees the request close asynchronously, so poll until it
		// does (bounded by the test timeout) rather than relying on a fixed delay
		const waitFor = async (condition: () => boolean) => {
			while (!condition()) {
				await setTimeout(1);
			}
		};

		it('should move the mtime stream to the new docker host', async function () {
			const [a, b] = await Promise.all([startEngine(), startEngine()]);
			const gc = new DockerGC();
			await gc.setDocker(a.dockerOpts);
			await gc.setupMtimeStream();
			await gc.setDocker(b.dockerOpts);
			await waitFor(() => a.openEventsRequests === 0);
			expect(a.eventsRequests).to.equal(1);
			expect(b.eventsRequests).to.equal(1);
			expect(b.openEventsRequests).to.equal(1);
			gc.destroyMtimeStream();
		});

		it('should restart the mtime stream on the next docker host after a failed setDocker', async function () {
			const [a, b, c] = await Promise.all([
				startEngine(),
				startEngine({ pingStatus: 500 }),
				startEngine(),
			]);
			const gc = new DockerGC();
			await gc.setDocker(a.dockerOpts);
			await gc.setupMtimeStream();
			let error: Error | undefined;
			try {
				await gc.setDocker(b.dockerOpts);
			} catch (err: any) {
				error = err;
			}
			expect(error).to.have.property('statusCode', 500);
			await gc.setDocker(c.dockerOpts);
			expect(c.eventsRequests).to.equal(1);
			expect(c.openEventsRequests).to.equal(1);
			gc.destroyMtimeStream();
		});

		it('should set up the mtime stream on the new docker host when called during a setup', async function () {
			let releaseListImages!: () => void;
			const listImagesGate = new Promise<void>((resolve) => {
				releaseListImages = resolve;
			});
			const [a, b] = await Promise.all([
				startEngine({ imagesGate: listImagesGate }),
				startEngine(),
			]);
			const gc = new DockerGC();
			await gc.setDocker(a.dockerOpts);
			const setup = gc.setupMtimeStream();
			// Wait for the setup to be waiting on the image list
			await waitFor(() => a.eventsRequests > 0);
			await gc.setDocker(b.dockerOpts);
			releaseListImages();
			await setup;
			await waitFor(() => a.openEventsRequests === 0);
			expect(b.eventsRequests).to.equal(1);
			expect(b.openEventsRequests).to.equal(1);
			gc.destroyMtimeStream();
		});

		it('should not restart the mtime stream if it is destroyed whilst connecting to the new docker host', async function () {
			let releasePing!: () => void;
			const pingGate = new Promise<void>((resolve) => {
				releasePing = resolve;
			});
			const [a, b] = await Promise.all([
				startEngine(),
				startEngine({ pingGate }),
			]);
			const gc = new DockerGC();
			await gc.setDocker(a.dockerOpts);
			await gc.setupMtimeStream();
			const setDocker = gc.setDocker(b.dockerOpts);
			await waitFor(() => b.pings > 0);
			gc.destroyMtimeStream();
			releasePing();
			await setDocker;
			expect(b.eventsRequests).to.equal(0);
		});
	});
});
