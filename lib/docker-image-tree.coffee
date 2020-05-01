_ = require 'lodash'
Promise = require 'bluebird'

saneRepoAttrs = (repoAttrs) ->
	return [] if !repoAttrs?
	return if '<none>:<none>' in repoAttrs or '<none>@<none>' in repoAttrs then [] else repoAttrs

exports.createNode = createNode = (id) -> { id: id, size: 0, repoTags: [], repoDigests: [], mtime: null, children: {} }

getMtimeFrom = (layer_mtimes, attributes) ->
	key = _.head(_.intersection(_.keys(layer_mtimes), attributes))
	if key?
		return layer_mtimes[key]

getMtime = (tree, layer_mtimes) ->
	mtime = layer_mtimes[tree.id]
	if mtime == undefined
		mtime = getMtimeFrom(layer_mtimes, tree.repoTags)
	if mtime == undefined
		mtime = getMtimeFrom(layer_mtimes, tree.repoDigests)
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

		node.repoTags = saneRepoAttrs(image.RepoTags)
		node.repoDigests = saneRepoAttrs(image.RepoDigests)
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
