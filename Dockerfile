FROM cronicle/edge:latest

COPY conf/config.json /opt/cronicle/conf/config.json

COPY conf/easypanel-plugin.json /opt/cronicle/conf/easypanel-plugin.json
COPY plugins /opt/cronicle/plugins
RUN chmod +x /opt/cronicle/plugins/easypanel-deploy.js

CMD ["manager"]
