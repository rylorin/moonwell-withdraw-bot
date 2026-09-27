FROM node:22

COPY package.json yarn.lock tsconfig.json /app/
COPY src/ /app/src/
RUN cd /app/ \
    && yarn install \
    && yarn build \
    && yarn test

ENV NODE_ENV=production

WORKDIR /app
CMD ["yarn", "start"]
