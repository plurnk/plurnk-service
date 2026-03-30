lexer grammar DockerfileLexer;

FROM: 'FROM' | 'from';
AS: 'AS' | 'as';
RUN: 'RUN' | 'run';
CMD: 'CMD' | 'cmd';
LABEL: 'LABEL' | 'label';
EXPOSE: 'EXPOSE' | 'expose';
ENV: 'ENV' | 'env';
ADD: 'ADD' | 'add';
COPY: 'COPY' | 'copy';
ENTRYPOINT: 'ENTRYPOINT' | 'entrypoint';
VOLUME: 'VOLUME' | 'volume';
USER: 'USER' | 'user';
WORKDIR: 'WORKDIR' | 'workdir';
ARG: 'ARG' | 'arg';
ONBUILD: 'ONBUILD' | 'onbuild';
STOPSIGNAL: 'STOPSIGNAL' | 'stopsignal';
HEALTHCHECK: 'HEALTHCHECK' | 'healthcheck';
SHELL: 'SHELL' | 'shell';

EQUALS: '=';
COLON: ':';
AT: '@';
DASH_DASH: '--';

COMMENT: '#' ~[\r\n]* -> skip;
NEWLINE: '\r'? '\n';
CONTINUATION: '\\' '\r'? '\n' -> skip;
WS: [ \t]+ -> skip;

STRING: '"' (~["\\\r\n] | '\\' .)* '"';
SINGLE_STRING: '\'' (~['\\\r\n] | '\\' .)* '\'';
WORD: ~[ \t\r\n=:@#"'\\]+;
