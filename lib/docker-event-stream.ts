import * as es from 'event-stream';
import JSONStream from 'JSONStream';
import type Docker from 'dockerode';

const IMAGE_EVENTS = ['delete', 'import', 'pull', 'push', 'tag'];

const CONTAINER_EVENTS = [
	'attach',
	'commit',
	'copy',
	'create',
	'destroy',
	'die',
	'exec_create',
	'exec_start',
	'export',
	'kill',
	'oom',
	'pause',
	'rename',
	'resize',
	'restart',
	'start',
	'stop',
	'top',
	'unpause',
];

export interface LayerMtimes {
	[id: string]: string | number | undefined;
}

interface DockerEvent {
	status: string;
	id: string;
	from: string;
	Type: 'container';
	Action: 'destroy';
	Actor: {
		ID: '9f49d061590dc6d242f902dff33a4536ac1baf584c19a4e68c0675178b4e567b';
		Attributes: {
			image: 'sha256:8ecd94718638c95609ec3a91d3241ce84b025de9bd089e1c463c8b4e7f83fc25';
			'io.balena.architecture': 'aarch64';
			'io.balena.device-type': 'jetson-xavier';
			'io.balena.qemu.version': '7.0.0+balena1-aarch64';
			maintainer: 'charlie <carlos.alvarez@kiwibot.com> dadaroce <davidson@kiwibot.com>';
			name: 'zen_lichterman';
		};
	};
	scope: 'local';
	time: 1701265973;
	timeNano: '1701265973112542359';
}

export const parseEventStream = async (docker: Docker) => {
	const images = await docker.listImages({ all: true });
	const layerMtimes: LayerMtimes = {};
	// Start off by setting all current images to an mtime of 0 as we've never seen them used
	// If we've never seen the layer used then it's likely created before we started
	// listening and so set the last used time to 0 as we know it should be older than
	// anything we've seen
	for (const image of images) {
		layerMtimes[image.Id] = 0;
	}

	return es.pipeline(
		JSONStream.parse(undefined) as any as es.MapStream,
		es.mapSync(function ({ status, id, from, timeNano }: DockerEvent) {
			if (IMAGE_EVENTS.includes(status)) {
				if (status === 'delete') {
					if (layerMtimes[id] != null) {
						delete layerMtimes[id];
					}
				} else {
					layerMtimes[id] = timeNano;
				}
			} else if (CONTAINER_EVENTS.includes(status)) {
				layerMtimes[from] = timeNano;
			}
			return layerMtimes;
		}),
	);
};

export async function dockerMtimeStream(docker: Docker) {
	const [stream, streamParser] = await Promise.all([
		docker.getEvents(),
		parseEventStream(docker),
	]);
	return es.pipeline(stream as any as es.MapStream, streamParser);
}
