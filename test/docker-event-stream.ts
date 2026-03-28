import type { LayerMtimes } from '../build/docker-event-stream';
import type Dockerode from 'dockerode';

import { expect } from 'chai';
import fs from 'fs';
import { Stream } from 'node:stream';
import { parseEventStream } from '../build/docker-event-stream';
import { getDocker } from '../build/docker';

import fixtureImages from './fixtures/docker-images.json';

const createMockDocker = (imageList = fixtureImages) =>
	({ listImages: () => Promise.resolve(imageList) }) as Dockerode;

describe('parseEventStream', function () {
	it.skip('should work with empty stream', function () {
		// TODO
	});

	it('should return updated mtimes', async () => {
		const docker = getDocker({});
		const streamParsers = await parseEventStream(docker);

		let mtimes: LayerMtimes;
		await Stream.promises.pipeline(
			fs.createReadStream(__dirname + '/fixtures/docker-events.json'),
			...streamParsers,
			new Stream.Transform({
				objectMode: true,
				transform($data: LayerMtimes, _encoding, cb) {
					mtimes = $data;
					cb();
				},
			}),
		);
		expect(mtimes!.get('busybox:latest')).to.equal(1448576072937294800);
		expect(
			mtimes!.get(
				'sha256:6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c',
			),
		).to.equal(1448576073085559800);
		expect(
			mtimes!.get(
				'sha256:9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e',
			),
		).to.equal(1448576073203895800);
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
});
