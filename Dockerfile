# FROM node:20-slim

# RUN apt-get update && apt-get install -y \
#     python3 \
#     curl \
#     ffmpeg \
#     && rm -rf /var/lib/apt/lists/*

# RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
#     -o /usr/local/bin/yt-dlp \
#     && chmod a+rx /usr/local/bin/yt-dlp

# WORKDIR /app

# COPY package*.json ./
# RUN npm ci --only=production

# COPY index.js .

# EXPOSE 3000

# CMD ["node", "index.js"]

FROM node:20

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip

RUN pip3 install yt-dlp

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]