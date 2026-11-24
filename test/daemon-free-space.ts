import type Docker from 'dockerode';
import { expect } from 'chai';
import DockerGC, { parseDfOutput } from '../build/index';

const DF_OUTPUT = [
	'Filesystem           1-blocks       Used Available Use% Mounted on',
	'overlay             1000000000 400000000 600000000  40% /',
].join('\r\n');

const createFakeDocker = (
	imageExists: boolean,
	output = DF_OUTPUT,
	{
		startError,
		removeError,
		statusCode = 0,
	}: { startError?: Error; removeError?: Error; statusCode?: number } = {},
) => {
	const fake = {
		removed: 0,
		getImage: () => ({
			inspect: () =>
				imageExists
					? Promise.resolve({})
					: Promise.reject(
							Object.assign(new Error('no such image'), { statusCode: 404 }),
						),
		}),
		createContainer: () =>
			Promise.resolve({
				start: () =>
					startError != null ? Promise.reject(startError) : Promise.resolve(),
				wait: () => Promise.resolve({ StatusCode: statusCode }),
				logs: () => Promise.resolve(Buffer.from(output)),
				remove: () => {
					fake.removed++;
					return removeError != null
						? Promise.reject(removeError)
						: Promise.resolve();
				},
			}),
	};
	return fake;
};

const createGC = (docker: ReturnType<typeof createFakeDocker>) => {
	const gc = new DockerGC();
	const pulls: string[] = [];
	Object.assign(gc, {
		docker: docker as unknown as Docker,
		dockerProgress: {
			pull: (image: string) => {
				pulls.push(image);
				return Promise.resolve();
			},
		},
	});
	return { gc, pulls };
};

describe('getDaemonFreeSpace', function () {
	let consoleLog: typeof console.log;
	before(function () {
		// Failing to remove the container is logged, keep the test output clean
		consoleLog = console.log;
		console.log = () => {
			// noop
		};
	});
	after(function () {
		console.log = consoleLog;
	});

	it('should not pull the base image if it already exists', async function () {
		const docker = createFakeDocker(true);
		const { gc, pulls } = createGC(docker);
		const du = await gc.getDaemonFreeSpace();
		expect(du).to.deep.equal({
			total: 1000000000,
			used: 400000000,
			free: 600000000,
		});
		expect(pulls).to.deep.equal([]);
		expect(docker.removed).to.equal(1);
	});

	it('should pull the base image if it is missing', async function () {
		const docker = createFakeDocker(false);
		const { gc, pulls } = createGC(docker);
		await gc.getDaemonFreeSpace();
		expect(pulls).to.deep.equal(['alpine:3.23']);
	});

	it('should remove the container if parsing fails', async function () {
		const docker = createFakeDocker(true, 'garbage');
		const { gc } = createGC(docker);
		let error: Error | undefined;
		try {
			await gc.getDaemonFreeSpace();
		} catch (err: any) {
			error = err;
		}
		expect(error).to.be.instanceOf(Error);
		expect(docker.removed).to.equal(1);
	});

	it('should remove the container if starting it fails', async function () {
		const docker = createFakeDocker(true, DF_OUTPUT, {
			startError: new Error('start failed'),
			removeError: new Error('remove failed'),
		});
		const { gc } = createGC(docker);
		let error: Error | undefined;
		try {
			await gc.getDaemonFreeSpace();
		} catch (err: any) {
			error = err;
		}
		expect(error).to.have.property('message', 'start failed');
		expect(docker.removed).to.equal(1);
	});

	it('should return the result even if removing the container fails', async function () {
		const docker = createFakeDocker(true, DF_OUTPUT, {
			removeError: new Error('remove failed'),
		});
		const { gc } = createGC(docker);
		expect(await gc.getDaemonFreeSpace()).to.deep.equal({
			total: 1000000000,
			used: 400000000,
			free: 600000000,
		});
	});

	it('should throw if df exits with an error', async function () {
		const docker = createFakeDocker(true, 'df: /: No such file or directory', {
			statusCode: 1,
		});
		const { gc } = createGC(docker);
		let error: Error | undefined;
		try {
			await gc.getDaemonFreeSpace();
		} catch (err: any) {
			error = err;
		}
		expect(error)
			.to.have.property('message')
			.that.matches(/exited with code 1: df: \/: No such file or directory/);
		expect(docker.removed).to.equal(1);
	});
});

describe('parseDfOutput', function () {
	it('should parse df output', function () {
		expect(parseDfOutput(DF_OUTPUT)).to.deep.equal({
			total: 1000000000,
			used: 400000000,
			free: 600000000,
		});
	});

	it('should parse GNU coreutils df output', function () {
		expect(
			parseDfOutput(
				[
					'Filesystem      1B-blocks      Used  Available Use% Mounted on',
					'overlay       1000000000 400000000  600000000  40% /',
				].join('\n'),
			),
		).to.deep.equal({ total: 1000000000, used: 400000000, free: 600000000 });
	});

	it('should parse df output where the filesystem name is on its own line', function () {
		expect(
			parseDfOutput(
				[
					'Filesystem           1-blocks       Used Available Use% Mounted on',
					'/dev/mapper/docker-8:1-1234567-0123456789abcdef0123456789abcdef',
					'                    1000000000 400000000 600000000  40% /',
				].join('\n'),
			),
		).to.deep.equal({ total: 1000000000, used: 400000000, free: 600000000 });
	});

	it('should throw on unexpected output', function () {
		expect(() => parseDfOutput('')).to.throw('Could not parse df output');
		expect(() =>
			parseDfOutput('Filesystem 1B-blocks Used Available Use% Mounted on\n'),
		).to.throw('Could not parse df output');
		expect(() =>
			parseDfOutput(
				'Filesystem 1B-blocks Used Available Use% Mounted on\noverlay a b c 40% /',
			),
		).to.throw('Could not parse df output');
	});

	it('should reject an unexpected header', function () {
		for (const header of [
			'df: unrecognized option',
			'Filesystem 1K-blocks Used Available Use% Mounted on',
			'Filesystem Size Used Avail Use% Mounted on',
		]) {
			expect(() =>
				parseDfOutput(`${header}\noverlay 1000 400 600 40% /`),
			).to.throw('Could not parse df output');
		}
	});

	for (const [description, line] of [
		['partial numbers', 'overlay 1000abc 400 600 40% /'],
		['exponents', 'overlay 1000 400 600e3 40% /'],
		['negative numbers', 'overlay 1000 -400 600 40% /'],
		['decimals', 'overlay 1000 400.5 600 40% /'],
		['unsafe integers', 'overlay 99999999999999999999 400 600 40% /'],
		['a missing use%', 'overlay 1000 400 600 40 /'],
		['extra fields', 'overlay 1000 400 600 40% / extra'],
		['missing fields', 'overlay 1000 400 600 40%'],
		['trailing output', 'overlay 1000 400 600 40% /\ndf: warning'],
		['another mountpoint', 'overlay 1000 400 600 40% /mnt'],
	]) {
		it(`should reject ${description}`, function () {
			expect(() =>
				parseDfOutput(
					`Filesystem 1B-blocks Used Available Use% Mounted on\n${line}`,
				),
			).to.throw('Could not parse df output');
		});
	}
});
