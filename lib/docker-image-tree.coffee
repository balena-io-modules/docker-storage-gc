_ = require 'lodash'
Docker = require 'dockerode'
Promise = require 'bluebird'

saneRepoTags = (repoTags) -> if '<none>:<none>' in repoTags then [] else repoTags

exports.createNode = createNode = (id) -> { id: id, size: 0, repoTags: [], mtime: null, children: {} }

exports.createTree = createTree = (images) ->
	tree = {}
	root = '0000000000000000000000000000000000000000000000000000000000000000'

	for image in images
		node = tree[image.Id] ?= createNode(image.Id)
		parentId = image.ParentId or root
		parent = tree[parentId] ?= createNode(parentId)

		node.repoTags = if image.RepoTags? then saneRepoTags(image.RepoTags) else '<No tag>'
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

docker = new Docker(socketPath: '/var/run/docker.sock')
docker = Promise.promisifyAll(docker)
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(Docker({}).getImage().constructor.prototype)

exports.getDocker = ->
	docker

exports.dockerImageTree = dockerImageTree = ->
	docker.listImagesAsync(all: true).then(createTree)
