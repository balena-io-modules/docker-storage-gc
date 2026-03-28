import JSONStream from 'JSONStream';
import type Docker from 'dockerode';
import { Stream } from 'node:stream';

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

export type LayerMtimes = Map<string, string | number | undefined>;

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

export const parseEventStream = async (
	docker: Docker,
	layerMtimes: LayerMtimes = new Map(),
) => {
	const images = await docker.listImages({ all: true });

	// Image events key by image ID, but container events key by
	// image name/tag, so we need all three to avoid removing valid
	// entries in the cleanup logic below
	const knownKeys = new Set(
		images.flatMap((image) => [
			image.Id,
			...(image.RepoTags ?? []),
			...(image.RepoDigests ?? []),
		]),
	);

	// Remove entries for images that no longer exist
	// This can happen if an image is deleted while the stream is down
	for (const key of layerMtimes.keys()) {
		if (!knownKeys.has(key)) {
			layerMtimes.delete(key);
		}
	}

	// Set mtime to 0 for images we haven't seen before, preserving
	// existing mtimes across stream restarts
	for (const image of images) {
		if (!layerMtimes.has(image.Id)) {
			layerMtimes.set(image.Id, 0);
		}
	}

	return [
		JSONStream.parse(undefined),
		new Stream.Transform({
			objectMode: true,
			transform(evt: DockerEvent, _encoding, cb) {
				try {
					const { status, id, from, timeNano } = evt;
					if (IMAGE_EVENTS.includes(status)) {
						if (status === 'delete') {
							layerMtimes.delete(id);
						} else {
							layerMtimes.set(id, timeNano);
						}
					} else if (CONTAINER_EVENTS.includes(status)) {
						layerMtimes.set(from, timeNano);
					}
					cb(null, layerMtimes);
				} catch (err: any) {
					cb(err);
				}
			},
		}),
	] as const;
};

export async function dockerMtimeStream(
	docker: Docker,
	layerMtimes: LayerMtimes = new Map(),
) {
	const [stream, streamParser] = await Promise.all([
		docker.getEvents(),
		parseEventStream(docker, layerMtimes),
	]);
	return Stream.pipeline(stream, ...streamParser, () => {
		// noop
	});
}
