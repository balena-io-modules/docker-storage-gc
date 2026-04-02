import type Docker from 'dockerode';
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
