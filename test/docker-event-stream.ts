import type { LayerMtimes } from '../build/docker-event-stream';
import type Dockerode from 'dockerode';

import { expect } from 'chai';
import fs from 'fs';
import { Stream } from 'node:stream';
import {
	normalizeImageRef,
	parseEventStream,
} from '../build/docker-event-stream';

import fixtureImages from './fixtures/docker-images.json';

const createMockDocker = (imageList = fixtureImages) =>
	({ listImages: () => Promise.resolve(imageList) }) as Dockerode;

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
		await parseEventStream(createMockDocker(), layerMtimes);
		expect(layerMtimes.get(existingId)).to.eq(val);
	});

	it('should set mtime to 0 for new images not in layerMtimes', async () => {
		const layerMtimes = new Map();
		await parseEventStream(createMockDocker(), layerMtimes);
		for (const image of fixtureImages) {
			expect(layerMtimes.get(image.Id)).to.eq(0);
		}
	});

	it('should remove entries for images that no longer exist', async () => {
		const key = 'sha256:nonexistent';
		const layerMtimes = new Map([[key, 1234567890]]);
		await parseEventStream(createMockDocker(), layerMtimes);
		expect(layerMtimes.has(key)).to.eq(false);
	});

	it('should preserve entries keyed by repo tags of existing images', async () => {
		const key = 'busybox:latest';
		const val = 9999999999;
		const layerMtimes = new Map([[key, val]]);
		await parseEventStream(createMockDocker(), layerMtimes);
		expect(layerMtimes.get(key)).to.eq(val);
	});

	it('should preserve entries keyed by repo digests of existing images', async () => {
		const key =
			'sha256:a8cf7ff6367c2afa2a90acd081b484cbded349a7076e7bdf37a05279f276bc12';
		const val = 8888888888;
		const layerMtimes = new Map([[key, val]]);
		await parseEventStream(createMockDocker(), layerMtimes);
		expect(layerMtimes.get(key)).to.eq(val);
	});

	it('should remove entries keyed by tags that no longer exist', async () => {
		const key = 'oldimage:v1';
		const layerMtimes = new Map([[key, 1234567890]]);
		await parseEventStream(createMockDocker(), layerMtimes);
		expect(layerMtimes.has(key)).to.eq(false);
	});

	it('should store container event mtime under the from key', async () => {
		const mtimes = await pipeEvents([
			{
				status: 'create',
				id: 'container1',
				from: 'myapp:latest',
				time: 1700000000,
			},
		]);
		expect(mtimes.get('myapp:latest')).to.equal(1700000000);
	});

	it('should store container event mtime under sha256 ID when from is an ID', async () => {
		const mtimes = await pipeEvents([
			{
				status: 'start',
				id: 'container1',
				from: 'sha256:abc123def456',
				time: 1700000000,
			},
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
	]) {
		it(`should normalize ${input}`, function () {
			expect(normalizeImageRef(input)).to.equal(expected);
		});
	}

	it('should match container events that reference an image without a tag', async () => {
		const mtimes = await pipeEvents([
			{ status: 'start', id: 'c1', from: 'alpine', time: 1700000000 },
			{
				status: 'start',
				id: 'c2',
				from: 'docker.io/library/busybox:1.36',
				time: 1700000001,
			},
		]);
		expect(mtimes.get('alpine:latest')).to.equal(1700000000);
		expect(mtimes.get('busybox:1.36')).to.equal(1700000001);
	});
});
