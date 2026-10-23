import { expect } from 'chai';
import http from 'http';
import type { AddressInfo } from 'net';
import DockerGC from '../build/index';

// A fake engine that only implements `GET /_ping`
const startFakeEngine = async () => {
	const server = http.createServer((req, res) => {
		if (req.url?.endsWith('/_ping')) {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('OK');
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	return {
		dockerOpts: { host: '127.0.0.1', port },
		close: () => new Promise((resolve) => server.close(resolve)),
	};
};

describe('setDocker', function () {
	it('should use the same docker instance for pulling images', async function () {
		const engine = await startFakeEngine();
		try {
			const gc = new DockerGC();
			await gc.setDocker(engine.dockerOpts);
			// @ts-expect-error docker and dockerProgress are private
			expect(gc.dockerProgress.docker).to.equal(gc.docker);
		} finally {
			await engine.close();
		}
	});
});
