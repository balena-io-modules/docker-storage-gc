import type Dockerode = require('dockerode');
import type EventEmitter = require('eventemitter3');

interface Events {
	numberImagesToRemove(n: number): void;
	gcRunTime(duration: number): void;
	imageRemoved(removalType: string): void;
	spaceReclaimed(reclaimSpace: number): void;
	imageRemovalError(statusCode: string): void;
}
declare class DockerGC {
	setHostname(hostname: string): void;
	setupMtimeStream(): Promise<void>;
	setDocker(dockerOpts: Dockerode.DockerOptions): Promise<void>;
	garbageCollect(reclaimSpace: number, attemptAll?: boolean): Promise<void>;
	getDaemonFreeSpace(): Promise<{
		used: number;
		total: number;
		free: number;
	}>;
	metrics: EventEmitter<Events>;
}
export = DockerGC;
