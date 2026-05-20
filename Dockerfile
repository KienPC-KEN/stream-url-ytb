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


FROM node:20-bullseye

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp

RUN chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./

RUN npm install --ignore-scripts

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]