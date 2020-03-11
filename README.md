# Docker storage Garbage Collection

## What it does

This node module connects to a Docker socket and deletes the least used images
until a threshold of disk usage is hit.

## How it works

### Layers

The goal of the module is to clean up layers from the disk. However, because
layers keep a reference to their parent layer, removal is not always possible.
The data structure that emerges from the layers is a tree of layers where each
layer points to their parent.

<p align="center">
  <img width="300" src="/doc/layer_tree.png?raw=true" alt="Layer tree illustration">
</p>

In order to have a single root for all the layer we assume a virtual empty
layer that all layers have as a parent and that is never deleted.

### Images

When interacting with a Docker daemon we don’t refer directly to layers. Our
unit of manipulation is an image, which can be thought of as a named pointer to
the combination of a layer and some configuration. For the purposes of the
garbage collector we only need to know which layers of our tree are entrypoints
for the images. Annotating the above tree with this information we end up with
something like this:

<p align="center">
  <img width="300" src="/doc/image_tree.png?raw=true" alt="Image tree illustration">
</p>

Whenever docker is asked to delete an image it will delete the layer the image
points to and all its ancestors until it hits a layer that is being used by
some other image. **From this follows that whenever we have a tree of layers
all the leaves are necessarily images, otherwise they would have been
deleted.**

Leaves are not the only images in the system though, an image can point to a
layer that is internal to the tree. In the figure above image `B` could be the
`ubuntu` base image and `H` and `L` two images that were based on the `ubuntu`
image.

### Eviction policy

When given a layer tree we can attempt to prune it in order to reclaim some
space. In order to decide what to prune we first need to come up with our
options and then rank them. At every step, the list of images that can reclaim
space are only the images at the leaves. In other words, removing the ubuntu
image while keeping another image that is based on ubuntu reclaims zero space.

In short, the algorithm this module is parameterized by the desired space to
reclaim and follows this procedure:

```python
reclaimed_space = 0
while reclaimed_space < reclaim_target:
    candidates = layer_tree.get_leaves()

    oldest = candidates.sort_by(‘last_used_time’)[0]
   
    reclaimed_space += calculate_saving(layer_tree, oldest)
    oldest.remove()
```

In order to calculate the expected saving of removing an image all we need to
do is walk up the tree of layers until we either find one that has more than
one child (i.e it’s being used by some other image) or find one that is an
image itself.

So from the figure above removing `L` will reclaim space equal to `L_space +
I_space` because `F` has more than one child. Proceeding to also remove `H`
will reclaim space equal to `H_space + F_space` because `B` is itself an image
and cannot be removed.

### Maintaining last used time

Docker does not track, and therefore does not offer over its API, the last time
an image was used. It only knows when an image was created. Using this date for
the eviction policy is undesirable because an image created long ago that is
being used all the time is very valuable. To remedy this this module subscribes
to the docker event stream and listens for containers starting/stopping and
other events that reference images. Every time an image is referenced the
module updates the metadata in its tree data structure that is then used for
the eviction policy.
