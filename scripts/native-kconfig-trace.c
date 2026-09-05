/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Linked only into a disposable copy of the selected upstream parser.
 * Observe lexer expansions; do not evaluate variables or read/write .config. */
#include "lkc.h"
#include <string.h>

static FILE *trace;
char *__real_expand_one_token(const char **str);
char *__real_expand_dollar(const char **str);

static void json_string(const char *s, size_t n)
{
	size_t i;
	fputc('"', trace);
	for (i = 0; i < n; i++) {
		unsigned char c = s[i];
		if (c == '"' || c == '\\') { fputc('\\', trace); fputc(c, trace); }
		else if (c < 32) fprintf(trace, "\\u%04x", c);
		else fputc(c, trace);
	}
	fputc('"', trace);
}

static char *expand(const char **str, int quoted)
{
	const char *start = *str;
	const char *file = current_file->name;
	int line = yylineno;
	char *result = quoted ? __real_expand_dollar(str) : __real_expand_one_token(str);
	fprintf(trace, "{\"file\":"); json_string(file, strlen(file));
	fprintf(trace, ",\"line\":%d,\"quoted\":%s,\"input\":", line, quoted ? "true" : "false");
	/* In STRING state the lexer has already consumed the dollar sign. */
	if (quoted) {
		char *input = xmalloc(*str - start + 2);
		input[0] = '$'; memcpy(input + 1, start, *str - start); input[*str - start + 1] = 0;
		json_string(input, strlen(input)); free(input);
	} else json_string(start, *str - start);
	fprintf(trace, ",\"output\":"); json_string(result, strlen(result));
	fputs("}\n", trace);
	return result;
}

char *__wrap_expand_one_token(const char **str) { return expand(str, 0); }
char *__wrap_expand_dollar(const char **str) { return expand(str, 1); }

int main(int argc, char **argv)
{
	if (argc != 3) return 2;
	trace = fopen(argv[2], "wb");
	if (!trace) return 2;
	conf_parse(argv[1]);
	return fclose(trace) ? 2 : 0;
}
