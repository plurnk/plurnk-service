# antlrmap
Use antlr4 to generate repomaps for llm agent context

## Introduction

antlrmap is a node utility that generates a map of all the symbols appropriate for llm contexts.

By relying upon the "Grammar Zoo" of EBNF files available for hundreds of languages, antlrmap
achieves more repo mapping more efficiently than tree sitters or lsps and more thoroughly than ctags. Most importantly, if you have a bespoke, obscure language, you can readily plug your antlr4 grammar in, apply the mapping filter, and you're good to go.


## Installation

```bash
npm i -g @possumtech/antlrmap
```

## Usage

```bash

```

## Contribution

Providing the mapping from the 300 languages to the standard repo map format is a
work in progress. LLMs are very good at this sort of thing, but many of the languages
require contextual knowledge to get the mapping correct or the EBNF files themselves
need work. The goal is 100%.
