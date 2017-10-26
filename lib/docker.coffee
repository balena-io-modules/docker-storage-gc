Docker = require 'dockerode'
Promise = require 'bluebird'
_ = require 'lodash'
path = require 'path'
fs = require 'mz/fs'
url = require 'url'

getDockerConnectOpts = (hostObj) ->

	return Promise.resolve(hostObj) if !_.isEmpty(hostObj)

	# Detect circleCi build
	if process.env.CIRCLECI?
		certs = ['ca.pem', 'cert.pem', 'key.pem'].map((file) -> path.join(process.env.DOCKER_CERT_PATH, file))

		Promise.map(certs, (c) -> fs.readFile(c, 'utf-8'))
		.then ([ca, cert, key]) ->

			parsed = url.parse(process.env.DOCKER_HOST)

			return {
				host: 'https://' + parsed.hostname
				port: parsed.port
				ca
				cert
				key
				Promise
			}
	else
		return Promise.resolve({ socketPath: '/var/run/docker.sock', Promise })

exports.getDocker = (hostObj) ->
	getDockerConnectOpts(hostObj)
	.then (opts) ->
		return new Docker(opts)
