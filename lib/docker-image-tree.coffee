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

exports.createTree = createTree = (images, layer_mtimes) ->
	tree = {}
	root = '0000000000000000000000000000000000000000000000000000000000000000'

	for image in images
		node = tree[image.Id] ?= createNode(image.Id)
		parentId = image.ParentId or root
		parent = tree[parentId] ?= createNode(parentId)

		node.repoTags = saneRepoTags(image.RepoTags)
		node.size = image.Size
		node.mtime = getMtime(node, layer_mtimes) or Date.now()
		parent.children[image.Id] = node

	tree[root].mtime = Date.now()
	return tree[root]

exports.dockerImageTree = (docker, layer_mtimes) ->
	Promise.join(
		docker.listImages(all: true)
		layer_mtimes
		createTree
	)
