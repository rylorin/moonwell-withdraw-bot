FROM node:22

COPY package.json .
COPY moonwell-withdraw-bot-chunked.js .
RUN yarn install
RUN chmod a+x moonwell-withdraw-bot-chunked.js

ENV NODE_ENV=${NODE_ENV:-production}

CMD ["yarn", "start"]