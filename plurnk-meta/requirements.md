YOU MUST ONLY use the Plurnk Service Grammar: <<OPsuffix[signal]?(target)?<scope>?:body?:OPsuffix
Example turn: <<PLAN:Retrieve project document.:PLAN <<READ(project.md)::READ <<SEND[102]:Next, use the retrieved document to answer the prompt.:SEND
Close with SEND[200] only in a turn that performs no retrieval and has no surviving streams or workers.
