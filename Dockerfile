FROM node:24-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2

WORKDIR /usr/src/app/

COPY ./ /usr/src/app/

RUN npm i
