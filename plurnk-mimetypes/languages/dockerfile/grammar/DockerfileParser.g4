parser grammar DockerfileParser;

options { tokenVocab = DockerfileLexer; }

dockerfile: NEWLINE* instruction (NEWLINE+ instruction)* NEWLINE* EOF;

instruction
    : fromInstruction
    | runInstruction
    | cmdInstruction
    | labelInstruction
    | exposeInstruction
    | envInstruction
    | addInstruction
    | copyInstruction
    | entrypointInstruction
    | volumeInstruction
    | userInstruction
    | workdirInstruction
    | argInstruction
    | onbuildInstruction
    | stopsignalInstruction
    | healthcheckInstruction
    | shellInstruction
    ;

fromInstruction: FROM (DASH_DASH argument)* imageName (AS stageName)?;
runInstruction: RUN arguments;
cmdInstruction: CMD arguments;
labelInstruction: LABEL labelPair+;
exposeInstruction: EXPOSE arguments;
envInstruction: ENV envPair+;
addInstruction: ADD (DASH_DASH argument)* arguments;
copyInstruction: COPY (DASH_DASH argument)* arguments;
entrypointInstruction: ENTRYPOINT arguments;
volumeInstruction: VOLUME arguments;
userInstruction: USER arguments;
workdirInstruction: WORKDIR arguments;
argInstruction: ARG argument (EQUALS argument)?;
onbuildInstruction: ONBUILD instruction;
stopsignalInstruction: STOPSIGNAL argument;
healthcheckInstruction: HEALTHCHECK arguments;
shellInstruction: SHELL arguments;

imageName: argument (COLON argument)? (AT argument)?;
stageName: argument;
labelPair: argument EQUALS argument;
envPair: argument (EQUALS argument)?;

arguments: argument+;
argument: WORD | STRING | SINGLE_STRING;
