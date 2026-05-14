FROM cronicle/edge:latest

COPY conf/easypanel-plugin.json /opt/cronicle/conf/easypanel-plugin.json
COPY plugins /opt/cronicle/plugins
RUN chmod +x /opt/cronicle/plugins/easypanel-deploy.js

CMD ["manager"]
