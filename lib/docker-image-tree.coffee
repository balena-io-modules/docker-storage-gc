_ = require 'lodash'
Promise = require 'bluebird'

saneRepoTags = (repoTags) ->
	return [] if !repoTags?
	return if '<none>:<none>' in repoTags then [] else repoTags

exports.createNode = createNode = (id) -> { id: id, size: 0, repoTags: [], mtime: null, children: {} }

getMtime = (tree, layer_mtimes) ->
	mtime = layer_mtimes[tree.id]
	if mtime == undefined
		key = _.head(_.intersection(_.keys(layer_mtimes), tree.repoTags))
		if key?
			mtime = layer_mtimes[key]
	return mtime

exports.createTree = createTree = (images, containers, layer_mtimes) ->
	now = Date.now() * 10 ** 6  # convert to nanoseconds
	usedImageIds = new Set(
		_(containers)
		.map('ImageID')
		.map (imageId) ->
			if imageId.startsWith('sha256:')
				imageId = imageId.slice(7)
			return imageId
	)
	tree = {}
	root = '0000000000000000000000000000000000000000000000000000000000000000'

	for image in images
		node = tree[image.Id] ?= createNode(image.Id)
		parentId = image.ParentId or root
		parent = tree[parentId] ?= createNode(parentId)

		node.repoTags = saneRepoTags(image.RepoTags)
		node.size = image.Size
		node.mtime = getMtime(node, layer_mtimes) or now
		node.isUsedByAContainer = usedImageIds.has(image.Id)
		parent.children[image.Id] = node

	tree[root].mtime = now
	tree[root].isUsedByAContainer = false
	return tree[root]

exports.dockerImageTree = (docker, layer_mtimes) ->
	Promise.join(
		docker.listImages(all: true)
		docker.listContainers(all: true)
		layer_mtimes
		createTree
	)
