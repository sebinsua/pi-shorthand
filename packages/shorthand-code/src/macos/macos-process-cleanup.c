#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

enum sandbox_filter_type {
	SANDBOX_FILTER_NONE,
	SANDBOX_FILTER_PATH,
};

extern int sandbox_check(pid_t, const char *, enum sandbox_filter_type, ...);
extern const enum sandbox_filter_type SANDBOX_CHECK_NO_REPORT;

static int matching_processes(const char *denied_path, const char *allowed_path, int terminate) {
	int capacity = proc_listallpids(NULL, 0);
	if (capacity <= 0) return -1;
	capacity += 128; // leave room for processes created between sizing and listing
	pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
	if (!pids) return -1;
	int count = proc_listallpids(pids, capacity * (int)sizeof(*pids));
	if (count < 0) {
		free(pids);
		return -1;
	}

	int matches = 0;
	for (int index = 0; index < count; index++) {
		pid_t pid = pids[index];
		if (pid <= 1 || pid == getpid()) continue;
		int denied = sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, denied_path);
		int allowed = sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, allowed_path);
		if (denied <= 0 || allowed != 0) continue;
		matches++;
		if (terminate && kill(pid, SIGKILL) != 0 && errno != ESRCH) {
			free(pids);
			return -1;
		}
	}
	free(pids);
	return matches;
}

int main(int argc, char **argv) {
	if (argc != 3) return 2;
	for (int attempt = 0; attempt < 20; attempt++) {
		int matches = matching_processes(argv[1], argv[2], 1);
		if (matches < 0) return 3;
		if (matches == 0) return 0;
		usleep(10000);
	}
	return matching_processes(argv[1], argv[2], 0) == 0 ? 0 : 4;
}
