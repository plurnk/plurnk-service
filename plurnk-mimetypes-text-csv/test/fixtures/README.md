# csv-spectrum

Complete corpus from max-mapper/csv-spectrum at
`d30e80f8b99d2eecb3778f1d7b9ed1cb425502ec` (2.0.0), by Max Ogden.
The upstream package declares BSD-2-Clause, not MIT. CSV bytes are stored as
base64; expected JSON is verbatim. Tests apply the upstream `.gitattributes`
rule `csvs/*_crlf.csv eol=crlf` after decoding the Git blob.

`location_coordinates` is not an oracle: its expected phone number differs
from the CSV, it expects an object rather than a row array, and its coordinate
field has unquoted embedded quotes outside RFC 4180. The test identifies this
inconsistent pair explicitly; no expected values are rewritten.

## License

Copyright Max Ogden.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
