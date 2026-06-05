FROM node:22

RUN apt-get update && \
    apt-get install -y python3 ffmpeg yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]