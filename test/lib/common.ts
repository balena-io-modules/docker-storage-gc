import type Docker from 'dockerode';
import type { ContainerInfo, ImageInfo } from 'dockerode';
import { getDocker } from '../../build/docker';

function parseDockerHost(): Docker.DockerOptions {
	const host = process.env.DOCKER_HOST ?? 'tcp://127.0.0.1:12375';
	if (host.startsWith('unix://')) {
		return { socketPath: host.slice('unix://'.length) };
	}
	if (host.startsWith('/')) {
		return { socketPath: host };
	}
	const url = new URL(host);
	return { host: url.hostname, port: parseInt(url.port, 10) || 2375 };
}

export const DOCKER_OPTS = parseDockerHost();

export const docker = getDocker(DOCKER_OPTS);

export const makeImage = (
	id: string,
	parentId: string,
	opts: {
		tags?: string[];
		digests?: string[];
		size?: number;
		sharedSize?: number;
	} = {},
): ImageInfo => ({
	Id: id,
	ParentId: parentId,
	RepoTags: opts.tags ?? ['<none>:<none>'],
	RepoDigests: opts.digests ?? ['<none>@<none>'],
	Size: opts.size ?? 100000,
	VirtualSize: opts.size ?? 100000,
	SharedSize: opts.sharedSize ?? 0,
	Containers: 0,
	Created: 0,
	Labels: {},
});

export const makeContainer = (imageId: string): ContainerInfo =>
	({ ImageID: imageId }) as unknown as ContainerInfo;

// A minimal stand-in for dockerode for unit tests that only need `listImages`,
// so that they can run without a real docker engine
export const createMockDocker = (imageList: readonly object[] = []) =>
	({ listImages: () => Promise.resolve(imageList) }) as unknown as Docker;
