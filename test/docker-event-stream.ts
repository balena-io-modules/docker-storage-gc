import type { LayerMtimes } from '../build/docker-event-stream';

import { expect } from 'chai';
import fs from 'fs';
import es from 'event-stream';
import { parseEventStream } from '../build/docker-event-stream';
import { getDocker } from '../build/docker';

describe('parseEventStream', function () {
	it.skip('should work with empty stream', function () {
		// TODO
	});

	it('should return updated mtimes', async () => {
		const docker = getDocker({});
		const streamParser = await parseEventStream(docker);
		const data = await new Promise<LayerMtimes>(function (resolve, reject) {
			let mtimes: LayerMtimes;

			return fs
				.createReadStream(__dirname + '/fixtures/docker-events.json')
				.pipe(streamParser)
				.on('error', reject)
				.pipe(es.mapSync(($data: LayerMtimes) => (mtimes = $data)))
				.on('end', () => {
					resolve(mtimes);
				})
				.on('error', reject);
		});
		expect(data)
			.to.have.property('busybox:latest')
			.that.equals(1448576072937294800);
		expect(data)
			.to.have.property(
				'sha256:6d41a4a0bf8168363e29da8a5ecbf3cd6c37e3f5a043decd5e7da6e427ba869c',
			)
			.that.equals(1448576073085559800);
		expect(data)
			.to.have.property(
				'sha256:9a61b6b1315e6b457c31a03346ab94486a2f5397f4a82219bee01eead1c34c2e',
			)
			.that.equals(1448576073203895800);
	});
});
