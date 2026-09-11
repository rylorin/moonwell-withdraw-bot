FROM node:22

COPY package.json /app/
COPY moonwell-withdraw-bot-chunked.js /app/
RUN cd /app/ \
    && yarn install \
    && chmod a+x moonwell-withdraw-bot-chunked.js

ENV NODE_ENV=${NODE_ENV:-production}

WORKDIR /app
CMD ["yarn", "start"]
