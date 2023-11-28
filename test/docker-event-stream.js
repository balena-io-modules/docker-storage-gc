const { expect } = require('chai');
const fs = require('fs');
const es = require('event-stream');
const { parseEventStream } = require('../build/docker-event-stream');
const dockerUtils = require('../build/docker');

describe('parseEventStream', function () {
	it.skip('should work with empty stream', function () {
		// TODO
	});

	it('should return updated mtimes', () =>
		dockerUtils
			.getDocker({})
			.then((docker) => parseEventStream(docker))
			.then(
				(streamParser) =>
					new Promise(function (resolve, reject) {
						let mtimes = null;

						return fs
							.createReadStream(__dirname + '/fixtures/docker-events.json')
							.pipe(streamParser)
							.on('error', reject)
							.pipe(es.mapSync((data) => (mtimes = data)))
							.on('end', () => resolve(mtimes))
							.on('error', reject);
					}),
			)
			.then(function (data) {
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
			}));
});
