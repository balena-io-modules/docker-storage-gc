import Docker from 'dockerode';

const getDockerConnectOpts = function (hostObj: Docker.DockerOptions) {
	if (Object.keys(hostObj).length > 0) {
		return hostObj;
	}
	return {
		socketPath: '/var/run/docker.sock',
	};
};

export function getDocker(hostObj: Docker.DockerOptions) {
	const opts = getDockerConnectOpts(hostObj);
	return new Docker(opts);
}
