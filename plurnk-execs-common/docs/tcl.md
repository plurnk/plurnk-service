# tcl

The body is a Tcl script fed to `tclsh` on stdin (a trailing newline is added).
A script target runs that file and receives the body as stdin; `{args=[...]}`
passes literal arguments, readable as `$argv`.

```example
### EXEC_ [tcl] <!-- the body is the program, unfenced -->
set words {alpha beta alpha}
foreach w $words { dict incr count $w }
puts [dict get $count alpha]

### EXEC_ [tcl] (tests/all.tcl) {args=["-verbose","bps"]}
```

`puts` streams to `#stdout`, `puts stderr ...` to `#stderr`; an uncaught error
or `exit 1` closes with status 500 with the Tcl error info on stderr. tclsh
evaluates the script line by line, so an incomplete command at the end is an
error, not a silent no-op.
