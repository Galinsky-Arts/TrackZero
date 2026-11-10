"""High-confidence current tracked source scan, not a history/comprehensive secrets audit."""
import re, subprocess, pathlib, sys
patterns=[re.compile(rb'(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}'),re.compile(rb'whsec_[A-Za-z0-9]{24,}'),re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{60,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]
paths=subprocess.check_output(['git','ls-files','-z']).split(b'\0')
findings=[]
for raw in paths:
 if not raw: continue
 path=pathlib.Path(raw.decode());
 if path.is_symlink() or not path.is_file():continue
 data=path.read_bytes()
 if any(pattern.search(data) for pattern in patterns):findings.append(str(path))
if findings:
 print('Possible embedded credential; review locally (values redacted): '+', '.join(findings),file=sys.stderr);sys.exit(1)
print('Current tracked files: no embedded Stripe keys or private PEM blocks matched. History and other secret formats are outside this check.')
