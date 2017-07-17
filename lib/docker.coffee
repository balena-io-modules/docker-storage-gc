Docker = require 'dockerode'
Promise = require 'bluebird'
path = require('path')
fs = require('mz/fs')
url = require('url')

# Cache the daemon
docker = null

getDockerConnectOpts = ->
	# Detect circleCi build
	if process.env.DOCKER_HOST? and process.env.DOCKER_TLS_VERIFY?
		certs = ['ca.pem', 'cert.pem', 'key.pem'].map((file) -> path.join(process.env.DOCKER_CERT_PATH, file))

		Promise.map(certs, (c) -> fs.readFile(c))
		.map((buf) -> buf.toString('utf8'))
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

exports.getDocker = ->
	return Promise.resolve(docker) if docker?
	getDockerConnectOpts()
	.then (opts) ->
		docker = new Docker(opts)
		return docker
