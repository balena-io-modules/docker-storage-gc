Docker = require 'dockerode'
Bluebird = require 'bluebird'
_ = require 'lodash'

getDockerConnectOpts = (hostObj) ->
	if !_.isEmpty(hostObj)
		return Bluebird.resolve(hostObj)
	return Bluebird.resolve({ socketPath: '/var/run/docker.sock', Promise: Bluebird })

exports.getDocker = (hostObj) ->
	getDockerConnectOpts(hostObj)
	.then (opts) ->
		return new Docker(opts)
