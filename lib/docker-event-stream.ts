import JSONStream from 'JSONStream';
import type Docker from 'dockerode';
import { Stream } from 'node:stream';
import type { Readable } from 'node:stream';

const IMAGE_EVENTS = [
	'create',
	'delete',
	'import',
	'load',
	'pull',
	'push',
	'tag',
];

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

export type LayerMtimes = Map<string, number>;

/**
 * Normalize an image reference to the familiar form that the engine reports in
 * `RepoTags`/`RepoDigests` (eg `alpine:latest`, `alpine@sha256:...`), or to a
 * full `sha256:` image ID. Container events reference the image exactly as the
 * container was created with it, eg `alpine` or `docker.io/library/alpine:3.18`,
 * so without this they would never match the image they were created from.
 * Short image IDs can't be told apart from repository names, so they are
 * normalized like one (eg `6d41a4a0bf81` becomes `6d41a4a0bf81:latest`) and
 * won't match the image they refer to.
 */
export const normalizeImageRef = (ref: string): string => {
	if (/^[a-f0-9]{64}$/.test(ref)) {
		return `sha256:${ref}`;
	}
	if (ref.startsWith('sha256:')) {
		return ref;
	}
	const digestIndex = ref.indexOf('@');
	let name = digestIndex === -1 ? ref : ref.slice(0, digestIndex);
	const digest = digestIndex === -1 ? undefined : ref.slice(digestIndex + 1);
	let tag = 'latest';
	const tagIndex = name.lastIndexOf(':');
	if (tagIndex > name.lastIndexOf('/')) {
		tag = name.slice(tagIndex + 1);
		name = name.slice(0, tagIndex);
	}
	name = name.replace(/^(?:docker\.io|index\.docker\.io)\//, '');
	if (/^library\/[^/]+$/.test(name)) {
		name = name.slice('library/'.length);
	}
	// The engine reports digest references without the tag
	return digest != null ? `${name}@${digest}` : `${name}:${tag}`;
};

/**
 * An event from `GET /events`. The legacy `status`, `id` and `from` fields
 * were deprecated in API v1.22 and are no longer sent from API v1.52 (Docker
 * v29), so only the `Type`/`Action`/`Actor` fields can be relied upon.
 * https://docs.docker.com/reference/api/engine/version-history/
 */
export interface DockerEvent {
	Type: string;
	/** Some actions include details after a colon, eg `exec_start: sh -c ls` */
	Action: string;
	Actor: {
		/** The image reference or ID for image events, the container ID for container events */
		ID: string;
		/** For container events `image` is the image reference the container was created with */
		Attributes?: Record<string, string>;
	};
	scope?: 'local' | 'swarm';
	/** Unix timestamp in seconds */
	time: number;
	timeNano: number;
}

export const parseEventStream = async (
	docker: Docker,
	layerMtimes: LayerMtimes = new Map(),
) => {
	const images = await docker.listImages({ all: true });

	// Image events key by image ID or reference (eg `pull`/`push`), and
	// container events key by the reference the container was created with, so
	// we need all three to avoid removing valid entries in the cleanup logic below
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
					const { Type, Actor, time } = evt;
					const action = evt.Action?.split(':', 1)[0];
					if (Type === 'image' && IMAGE_EVENTS.includes(action)) {
						if (action === 'delete') {
							layerMtimes.delete(normalizeImageRef(Actor.ID));
						} else {
							layerMtimes.set(normalizeImageRef(Actor.ID), time);
						}
					} else if (
						Type === 'container' &&
						CONTAINER_EVENTS.includes(action)
					) {
						const image = Actor.Attributes?.image;
						if (image != null) {
							layerMtimes.set(normalizeImageRef(image), time);
						}
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
	const [stream, streamParser] = await Promise.allSettled([
		// We only care about image and container events
		docker.getEvents({ filters: { type: ['image', 'container'] } }),
		parseEventStream(docker, layerMtimes),
	]);
	if (stream.status === 'rejected') {
		throw stream.reason;
	}
	if (streamParser.status === 'rejected') {
		// Make sure we don't leave the events request open
		(stream.value as Readable).destroy();
		throw streamParser.reason;
	}
	// Errors are propagated to the returned stream by destroying it, and
	// destroying the returned stream will destroy the events request too
	return Stream.pipeline(stream.value, ...streamParser.value, () => {
		// noop
	});
}
