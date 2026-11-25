import type { DockerEvent, LayerMtimes } from '../build/docker-event-stream';

import { expect } from 'chai';
import fs from 'fs';
import { Stream } from 'node:stream';
import {
	dockerMtimeStream,
	normalizeImageRef,
	parseEventStream,
} from '../build/docker-event-stream';
import { createMockDocker } from './lib/common';

import fixtureImages from './fixtures/docker-images.json';

const imageEvent = (action: string, id: string, time: number): DockerEvent => ({
	Type: 'image',
	Action: action,
	Actor: { ID: id, Attributes: {} },
	time,
	timeNano: time * 1e9,
});

const containerEvent = (
	action: string,
	image: string,
	time: number,
): DockerEvent => ({
	Type: 'container',
	Action: action,
	Actor: { ID: 'container1', Attributes: { image } },
	time,
	timeNano: time * 1e9,
});

const pipeEvents = async (events: object[]): Promise<LayerMtimes> => {
	const streamParsers = await parseEventStream(createMockDocker([]));
	let mtimes: LayerMtimes = new Map();
	const input = new Stream.Readable({
		read() {
			for (const evt of events) {
				this.push(JSON.stringify(evt) + '\n');
			}
			this.push(null);
		},
	});
	await Stream.promises.pipeline(
		input,
		...streamParsers,
		new Stream.Transform({
			objectMode: true,
			transform(data: LayerMtimes, _encoding, cb) {
				mtimes = data;
				cb();
			},
		}),
	);
	return mtimes;
};

describe('parseEventStream', function () {
	it.skip('should work with empty stream', function () {
		// TODO
	});

	it('should return updated mtimes', async () => {
		const lines = (
			await fs.promises.readFile(
				__dirname + '/fixtures/docker-events.json',
				'utf8',
			)
		)
			.trim()
			.split('\n');
		const mtimes = await pipeEvents(lines.map((line) => JSON.parse(line)));
		expect(mtimes.get('busybox:latest')).to.equal(1448576072);
		expect(
			mtimes.get(
				'sha256:6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c',
			),
		).to.equal(1448576073);
		expect(
			mtimes.get(
				'sha256:9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e',
			),
		).to.equal(1448576073);
	});
});

describe('parseEventStream mtime persistence', function () {
	it('should preserve existing mtimes for current images', async () => {
		const existingId = fixtureImages[0].Id;
		const val = 1234567890;
		const layerMtimes = new Map([[existingId, val]]);
		await parseEventStream(createMockDocker(fixtureImages), layerMtimes);
		expect(layerMtimes.get(existingId)).to.eq(val);
	});

	it('should set mtime to 0 for new images not in layerMtimes', async () => {
		const layerMtimes = new Map();
		await parseEventStream(createMockDocker(fixtureImages), layerMtimes);
		for (const image of fixtureImages) {
			expect(layerMtimes.get(image.Id)).to.eq(0);
		}
	});

	it('should remove entries for images that no longer exist', async () => {
		const key = 'sha256:nonexistent';
		const layerMtimes = new Map([[key, 1234567890]]);
		await parseEventStream(createMockDocker(fixtureImages), layerMtimes);
		expect(layerMtimes.has(key)).to.eq(false);
	});

	it('should preserve entries keyed by repo tags of existing images', async () => {
		const key = 'busybox:latest';
		const val = 9999999999;
		const layerMtimes = new Map([[key, val]]);
		await parseEventStream(createMockDocker(fixtureImages), layerMtimes);
		expect(layerMtimes.get(key)).to.eq(val);
	});

	it('should preserve entries keyed by repo digests of existing images', async () => {
		const key =
			'sha256:a8cf7ff6367c2afa2a90acd081b484cbded349a7076e7bdf37a05279f276bc12';
		const val = 8888888888;
		const layerMtimes = new Map([[key, val]]);
		await parseEventStream(createMockDocker(fixtureImages), layerMtimes);
		expect(layerMtimes.get(key)).to.eq(val);
	});

	it('should remove entries keyed by tags that no longer exist', async () => {
		const key = 'oldimage:v1';
		const layerMtimes = new Map([[key, 1234567890]]);
		await parseEventStream(createMockDocker(fixtureImages), layerMtimes);
		expect(layerMtimes.has(key)).to.eq(false);
	});

	it('should store container event mtime under the image attribute', async () => {
		const mtimes = await pipeEvents([
			containerEvent('create', 'myapp:latest', 1700000000),
		]);
		expect(mtimes.get('myapp:latest')).to.equal(1700000000);
	});

	it('should store container event mtime under sha256 ID when the image attribute is an ID', async () => {
		const mtimes = await pipeEvents([
			containerEvent('start', 'sha256:abc123def456', 1700000000),
		]);
		expect(mtimes.get('sha256:abc123def456')).to.equal(1700000000);
	});
});

describe('normalizeImageRef', function () {
	const id = '6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c';
	const digest =
		'sha256:a8cf7ff6367c2afa2a90acd081b484cbded349a7076e7bdf37a05279f276bc12';
	for (const [input, expected] of [
		['alpine', 'alpine:latest'],
		['alpine:3.18', 'alpine:3.18'],
		['library/alpine:3.18', 'alpine:3.18'],
		['docker.io/library/alpine', 'alpine:latest'],
		['docker.io/library/alpine:3.18', 'alpine:3.18'],
		['index.docker.io/library/alpine:3.18', 'alpine:3.18'],
		['docker.io/balena/open-balena-api', 'balena/open-balena-api:latest'],
		['balena/open-balena-api:v1', 'balena/open-balena-api:v1'],
		['localhost:5000/foo', 'localhost:5000/foo:latest'],
		['localhost:5000/foo:bar', 'localhost:5000/foo:bar'],
		[
			'registry.example.com/library/foo:1',
			'registry.example.com/library/foo:1',
		],
		[`alpine@${digest}`, `alpine@${digest}`],
		[`alpine:3.18@${digest}`, `alpine@${digest}`],
		[`docker.io/library/alpine@${digest}`, `alpine@${digest}`],
		[
			`registry2.balena-cloud.com/v2/abc@${digest}`,
			`registry2.balena-cloud.com/v2/abc@${digest}`,
		],
		[id, `sha256:${id}`],
		[`sha256:${id}`, `sha256:${id}`],
		// Short IDs are indistinguishable from repository names
		[id.slice(0, 12), `${id.slice(0, 12)}:latest`],
	]) {
		it(`should normalize ${input}`, function () {
			expect(normalizeImageRef(input)).to.equal(expected);
		});
	}

	it('should match container events that reference an image without a tag', async () => {
		const mtimes = await pipeEvents([
			containerEvent('start', 'alpine', 1700000000),
			containerEvent('start', 'docker.io/library/busybox:1.36', 1700000001),
		]);
		expect(mtimes.get('alpine:latest')).to.equal(1700000000);
		expect(mtimes.get('busybox:1.36')).to.equal(1700000001);
	});

	it('should normalize image IDs from image events, including delete', async () => {
		const mtimes = await pipeEvents([
			imageEvent('pull', 'docker.io/library/alpine', 1700000000),
			imageEvent('pull', 'docker.io/library/busybox', 1700000001),
			imageEvent('delete', 'docker.io/library/busybox', 1700000002),
		]);
		expect([...mtimes]).to.deep.equal([['alpine:latest', 1700000000]]);
	});
});

describe('parseEventStream event formats', function () {
	it('should not depend on the legacy status/id/from fields (removed in API v1.52)', async () => {
		const mtimes = await pipeEvents([
			imageEvent('pull', 'alpine:3.18', 1700000000),
			containerEvent('start', 'alpine:3.18', 1700000001),
			imageEvent('tag', 'sha256:abc', 1700000002),
		]);
		expect(mtimes.get('alpine:3.18')).to.equal(1700000001);
		expect(mtimes.get('sha256:abc')).to.equal(1700000002);
	});

	it('should ignore the legacy-only event format', async () => {
		const mtimes = await pipeEvents([
			{ status: 'start', id: 'c1', from: 'legacy:v1', time: 1700000000 },
		]);
		expect(mtimes.has('legacy:v1')).to.equal(false);
	});

	it('should handle actions that include details after a colon', async () => {
		const mtimes = await pipeEvents([
			containerEvent('exec_start: sh -c ls', 'myapp:latest', 1700000000),
		]);
		expect(mtimes.get('myapp:latest')).to.equal(1700000000);
	});

	it('should remove the mtime on image delete', async () => {
		const mtimes = await pipeEvents([
			imageEvent('tag', 'sha256:abc', 1700000000),
			imageEvent('delete', 'sha256:abc', 1700000001),
		]);
		expect(mtimes.has('sha256:abc')).to.equal(false);
	});

	it('should ignore events for other object types', async () => {
		const mtimes = await pipeEvents([
			{
				Type: 'network',
				Action: 'create',
				Actor: { ID: 'net1', Attributes: { image: 'myapp:latest' } },
				time: 1700000000,
				timeNano: 1700000000000000000,
			},
		]);
		expect(mtimes.has('myapp:latest')).to.equal(false);
		expect(mtimes.has('net1')).to.equal(false);
	});

	it('should track image create and load events by image ID', async () => {
		const mtimes = await pipeEvents([
			imageEvent('create', 'sha256:built', 1700000000),
			imageEvent('load', 'sha256:loaded', 1700000001),
		]);
		expect(mtimes.get('sha256:built')).to.equal(1700000000);
		expect(mtimes.get('sha256:loaded')).to.equal(1700000001);
	});

	it('should not treat an image create event as a container event', async () => {
		const mtimes = await pipeEvents([
			{
				...imageEvent('create', 'sha256:built', 1700000000),
				// Image events never have an image attribute, but make sure it is ignored
				Actor: { ID: 'sha256:built', Attributes: { image: 'myapp:latest' } },
			},
		]);
		expect([...mtimes.keys()]).to.deep.equal(['sha256:built']);
	});

	it('should handle events that include both the legacy and current fields (API < v1.52)', async () => {
		const mtimes = await pipeEvents([
			{
				status: 'pull',
				id: 'busybox:latest',
				...imageEvent('pull', 'busybox:latest', 1700000000),
			},
			{
				status: 'start',
				id: 'container1',
				from: 'alpine:3.18',
				...containerEvent('start', 'alpine:3.18', 1700000001),
			},
		]);
		expect(mtimes.get('busybox:latest')).to.equal(1700000000);
		expect(mtimes.get('alpine:3.18')).to.equal(1700000001);
	});
});

describe('dockerMtimeStream', function () {
	it('should only request image and container events', async () => {
		let eventsOpts: unknown;
		const docker = {
			listImages: () => Promise.resolve([]),
			getEvents: (opts: unknown) => {
				eventsOpts = opts;
				return Promise.resolve(Stream.Readable.from([]));
			},
		} as unknown as Dockerode;
		const stream = await dockerMtimeStream(docker);
		stream.destroy();
		expect(eventsOpts).to.deep.equal({
			filters: { type: ['image', 'container'] },
		});
	});
});
