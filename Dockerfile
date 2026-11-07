# 乱翻书 KanPDF — 局域网 / 自托管网页版
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
RUN mkdir -p /usr/share/nginx/html/books
EXPOSE 80
