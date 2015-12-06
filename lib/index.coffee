Promise = require 'bluebird'
_ = require 'lodash'
es = require 'event-stream'
fs = require 'fs'
Docker = require 'dockerode'
JSONStream = require 'JSONStream'

docker = new Docker(socketPath: '/var/run/docker.sock')
docker = Promise.promisifyAll(docker)

IMAGE_EVENTS = [ 'delete', 'import', 'pull', 'push', 'tag', 'untag' ]
CONTAINER_EVENTS = [
	'attach',      'commit',  'copy',  'create',  'destroy',  'die',     'exec_create',
	'exec_start',  'export',  'kill',  'oom',     'pause',    'rename',  'resize',
	'restart',     'start',   'stop',  'top',     'unpause'
]

# docker.getEventsAsync()
# .then (stream) ->
# 	stream.pipe(require('fs').createWriteStream('./test/fixtures/docker-events.json'))
# 
exports.parseEventStream = parseEventStream = ->
	layer_mtimes = {}

	es.pipeline(
		JSONStream.parse()
		es.mapSync ({status, id, from, time}) ->
			if status in IMAGE_EVENTS
				layer_mtimes[id] = time * 1000
			else
				layer_mtimes[from] = time * 1000
			return layer_mtimes
	)

saneRepoTags = (repoTags) -> if '<none>:<none>' in repoTags then [] else repoTags

exports.createNode = createNode = (id) -> { id: id, size: 0, repoTags: [], mtime: null, children: {} }

exports.createTree = createTree = (images) ->
	tree = {}
	root = '0000000000000000000000000000000000000000000000000000000000000000'

	for image in images
		node = tree[image.Id] ?= createNode(image.Id)
		parentId = image.ParentId or root
		parent = tree[parentId] ?= createNode(parentId)

		node.repoTags = saneRepoTags(image.RepoTags)
		node.size = image.Size
		parent.children[image.Id] = node

	return tree[root]

exports.annotateTree = annotateTree = (layer_mtimes, tree) ->
	return {
		id: tree.id
		repoTags: tree.repoTags
		size: tree.size
		mtime: layer_mtimes[tree.id] or Date.now()
		children: _.mapValues(tree.children, annotateTree.bind(null, layer_mtimes))
	}

compare = (a, b) ->
	if a.mtime isnt b.mtime
		return a.mtime - b.mtime
	else
		return a.size - b.size

# arr is array of arrays to be merged
# modifies arrs, TODO: offsets
exports.merge = merge = (arrs, comp) ->
	comp ?= (a, b) -> a - b
	ret = []

	totalLength = _.sum(([arr.length for arr in arrs])...)

	for i in [0...totalLength]
		min = null
		minArrayIndex = null
		for arr, index in arrs when arr.length isnt 0
			if min is null or comp(arr[0], min) < 0
				min = arr[0]
				minArrayIndex = index
		ret.push(min)
		arrs[minArrayIndex].shift()

	return ret

exports.lruSort = lruSort = (tree) ->
	tree = _.clone(tree)
	children = tree.children
	delete tree.children

	ret = merge((lruSort(child) for own id, child of children), (a, b) -> a.mtime - b.mtime)

	if tree.repoTags.length is 0 and ret.length isnt 0
		ret[ret.length - 1].size += tree.size
	else
		ret.push(tree)

	return ret
		
# docker.listImagesAsync(all: true)
# .then (images) ->
# 	fs.writeFileSync('test/fixtures/docker-images.json', JSON.stringify(images, null, 4))
# gc = ->
# 	tree = createTree()
# 	annotate(tree, layer_mtimes)
# 
# 	cleanup(tree, 10 * 1000)

# createTree()
