FROM node:24-alpine3.23

WORKDIR /usr/src/app/

COPY ./ /usr/src/app/

RUN npm i
