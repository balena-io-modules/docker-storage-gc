import type Docker from 'dockerode';
import { expect } from 'chai';
import type { RemovalType } from '../build/index';
import DockerGC from '../build/index';

describe('metrics', function () {
	it('should record the gc run time even if listing images fails', async function () {
		const gc = new DockerGC();
		Object.assign(gc, {
			docker: {
				listImages: () => Promise.reject(new Error('listImages failed')),
				listContainers: () => Promise.resolve([]),
			} as unknown as Docker,
		});
		const runTimes: number[] = [];
		gc.metrics.on('gcRunTime', (duration) => runTimes.push(duration));
		let error: Error | undefined;
		try {
			await gc.garbageCollect(1);
		} catch (err: any) {
			error = err;
		}
		expect(error).to.have.property('message', 'listImages failed');
		expect(runTimes).to.have.length(1);
	});

	it('should type the event listener arguments', function () {
		const gc = new DockerGC();
		// These are compile time checks, ensuring the listeners receive the correct types
		gc.metrics.on('imageRemoved', (removalType) => {
			const t: RemovalType = removalType;
			return t;
		});
		gc.metrics.on('imageRemovalError', (statusCode) => {
			const code: number | undefined = statusCode;
			return code;
		});
		expect(gc.metrics.listenerCount('imageRemoved')).to.equal(1);
	});
});
