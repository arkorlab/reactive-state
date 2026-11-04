# vocabulary

Holds this repository to the words any host would use.

The framework runs on whichever host serves the application, so nothing here may describe one host
in particular: by its name, by the names of the parts it is made of, or by what it charges for.
`src/terms.ts` lists each word that is refused and why, with what it must find and what it must
pass over; the check tries those examples before it reads a file.

```bash
pnpm check:vocabulary                  # every mention, by file, line and column
pnpm check:vocabulary --format github  # the same, as annotations on a pull request
```

Every file the repository holds is read, tracked or not, minus what `.gitignore` leaves out and the
paths `src/main.ts` excludes: this tool itself, whose terms and tests hold the words it looks for,
the lockfile, and the application the package's tests compile, kept byte for byte as their input.
There is no baseline: the repository says none of the words. A file is searched whole — comments
and Markdown included, a term of several words found where a soft line break falls inside it, and
an identifier read as the words it is made of (`controlPlane`) — and so is its path, a binary's
included. A term is found in its plural as well, where the plural names the same thing. A file of a
binary kind — an image, a font, an archive — is left unread where its first bytes say it is binary,
however large it is; one that reads as text is searched as any text is, within the same bounds.

What is said under the publisher's name and is no mention of a host is blanked first, to something
that joins no words on either side of it: the `x-arkor-edge` header of the edge the framework runs
behind, that edge's `.arkor` build directory and `__arkor` marker, the organization's `arkorlab`
name, the security contact, and the copyright line of the licences. Each is blanked only where
nothing of a name — a letter or a digit of any script, `_` or `-` — stands next to it, so another
name made from it is still searched as any name is. The security contact is an address, so it is
searched as well where a `.` or a `+` stands before it, a `+` after it, or a `.` that a letter or a
digit follows, as in a longer domain; a full stop that ends a sentence after it is no such `.`. An
addition to that list is reviewed as a change of its own.
