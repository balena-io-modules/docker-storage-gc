_ = require 'lodash'

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

compare = (a, b) ->
	if a.mtime isnt b.mtime
		return a.mtime - b.mtime
	else
		return a.size - b.size

exports.lruSort = lruSort = (tree) ->
	tree = _.clone(tree)
	children = tree.children
	delete tree.children

	ret = merge((lruSort(child) for own id, child of children), compare)

	if tree.repoTags.length is 0 and ret.length isnt 0
		ret[ret.length - 1].size += tree.size
	else
		ret.push(tree)

	return ret
