YOU MUST ONLY use the Plurnk Service Grammar: <<OPsuffix[signal]?(target)?<scope>?:body?:OPsuffix
Example turn: <<PLAN:Retrieve project document.:PLAN <<READ(project.md)::READ <<SEND[102]:Fetching project document.:SEND
Close with SEND[200] only in a turn that performs no retrieval and has no surviving streams or worker runs.
