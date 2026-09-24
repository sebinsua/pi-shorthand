/* Linux native syscall observer. Storage/isolation remain bubblewrap + OverlayFS.
 * The host broker retains originals before repository access. Missing observation
 * terminates the trace; PTRACE_O_EXITKILL prevents a surviving unobserved child.
 */
#define _GNU_SOURCE
#include <sys/ptrace.h>
#include <linux/ptrace.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/fs.h>
#include <sched.h>
#include <elf.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stddef.h>

static int broker;
static const char *repository;
static size_t repository_length;
static pid_t initial;
static volatile sig_atomic_t stopping;
static int unresolved_external_permission;

enum observation_kind {
    OBSERVE_CONTENTS = 'C',
    OBSERVE_DIRECTORY = 'D',
    OBSERVE_FINISHED = 'F',
    OBSERVE_HELLO = 'H',
    OBSERVE_METADATA = 'M',
    OBSERVE_RENAME = 'R',
    OBSERVE_TREE = 'T',
    OBSERVE_ERROR = 'X',
};

static void stop_requested(int signal) { (void)signal; stopping = 1; }
static void die(const char *message) {
    if (broker > 0) {
        char packet[1024], reason[1000];
        snprintf(reason, sizeof(reason), "%s (%s)", message, strerror(errno));
        uint32_t length = htonl(strlen(reason)), zero = 0;
        packet[0] = OBSERVE_ERROR;
        memcpy(packet+1, &length, 4);
        memcpy(packet+5, &zero, 4);
        memcpy(packet+9, reason, strlen(reason));
        send(broker, packet, 9+strlen(reason), MSG_NOSIGNAL|MSG_DONTWAIT);
    }
    fprintf(stderr, "Incomplete transaction observation: %s (%s)\n", message, strerror(errno));
    exit(125);
}
static void transfer(int fd, void *buffer, size_t length, int writing) {
    while (length) {
        ssize_t count = writing ? write(fd, buffer, length) : read(fd, buffer, length);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) die("observation channel closed");
        buffer = (char *)buffer + count;
        length -= count;
    }
}
static void request(char kind, const char *first, const char *second) {
    uint32_t lengths[2] = { htonl(strlen(first)), htonl(strlen(second)) };
    transfer(broker, &kind, 1, 1);
    transfer(broker, lengths, sizeof(lengths), 1);
    transfer(broker, (void *)first, strlen(first), 1);
    transfer(broker, (void *)second, strlen(second), 1);
    char accepted;
    transfer(broker, &accepted, 1, 0);
    if (accepted != 1) die("repository observation rejected");
}
static int within(const char *file) {
    return !strncmp(file, repository, repository_length) &&
        (file[repository_length] == '/' || file[repository_length] == 0);
}
static void capture(const char *file, char kind) {
    if (!within(file)) return;
    const char *relative = file + repository_length;
    if (*relative == '/') relative++;
    request(kind, *relative ? relative : ".", "");
}
/* Returns 0 when the stopped thread is gone (ESRCH): SIGKILL or a sibling's exec retired it, so the syscall it
 * stopped in never executes and there is nothing to observe. */
static int trace_string(pid_t pid, uint64_t address, char result[PATH_MAX]) {
    for (size_t offset = 0; offset < PATH_MAX;) {
        uintptr_t location = address + offset;
        size_t skip = location % sizeof(long);
        errno = 0;
        long word = ptrace(PTRACE_PEEKDATA, pid, (void *)(location - skip), 0);
        if (errno == ESRCH) return 0;
        if (errno) die("cannot inspect syscall path");
        size_t count = sizeof(word) - skip;
        if (count > PATH_MAX - offset) count = PATH_MAX - offset;
        memcpy(result + offset, (char *)&word + skip, count);
        if (memchr((char *)&word + skip, 0, count)) return 1;
        offset += count;
    }
    die("overlong syscall path");
}
static void descriptor(pid_t pid, int fd, char result[PATH_MAX]) {
    char proc[96];
    if (fd == AT_FDCWD) snprintf(proc, sizeof(proc), "/proc/%d/cwd", pid);
    else snprintf(proc, sizeof(proc), "/proc/%d/fd/%d", pid, fd);
    ssize_t length = readlink(proc, result, PATH_MAX - 1);
    if (length < 0) {
        if (errno != ENOENT) die("cannot resolve tracee descriptor");
        result[0] = 0; /* closed/invalid descriptor cannot access an object */
        return;
    }
    result[length] = 0;
    if (within(result) && strstr(result, " (deleted)")) die("unresolved deleted repository descriptor");
}
/* A missing getprocattr hook reports EINVAL. Other errors, including a label
 * larger than our buffer, leave the access context unknown. */
static int security_label(const char *path, char label[4096], size_t *length) {
    int fd = open(path, O_RDONLY|O_CLOEXEC);
    if (fd < 0) return -1;
    size_t used = 0;
    for (;;) {
        char extra;
        char *destination = used < 4096 ? label + used : &extra;
        size_t available = used < 4096 ? 4096 - used : 1;
        ssize_t count = read(fd, destination, available);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) {
            int error = errno;
            close(fd);
            return used == 0 && error == EINVAL ? 0 : -1;
        }
        if (!count) { close(fd); *length = used; return 1; }
        if (used == 4096) { close(fd); return -1; }
        used += count;
    }
}
static int same_access_context(pid_t pid) {
    char tracee_path[96], tracee[4096], self[4096];
    snprintf(tracee_path, sizeof(tracee_path), "/proc/%d/status", pid);
    FILE *a = fopen(tracee_path, "r"), *b = fopen("/proc/self/status", "r");
    if (!a || !b) { if (a) fclose(a); if (b) fclose(b); return 0; }
    const char *fields[] = { "Uid:", "Gid:", "Groups:", "CapEff:" };
    unsigned matched = 0;
    while (fgets(tracee, sizeof(tracee), a)) {
        for (size_t j = 0; j < sizeof(fields)/sizeof(*fields); j++) {
            if (strncmp(tracee, fields[j], strlen(fields[j]))) continue;
            if (!strchr(tracee, '\n')) { fclose(a); fclose(b); return 0; }
            rewind(b);
            int found = 0;
            while (fgets(self, sizeof(self), b)) {
                if (!strncmp(self, fields[j], strlen(fields[j]))) {
                    if (!strchr(self, '\n') || strcmp(tracee, self)) { fclose(a); fclose(b); return 0; }
                    found = 1;
                    break;
                }
            }
            matched += found;
        }
    }
    fclose(a); fclose(b);
    if (matched != sizeof(fields)/sizeof(*fields)) return 0;
    snprintf(tracee_path, sizeof(tracee_path), "/proc/%d/attr/current", pid);
    size_t tracee_length = 0, self_length = 0;
    int tracee_label = security_label(tracee_path, tracee, &tracee_length);
    int self_label = security_label("/proc/self/attr/current", self, &self_length);
    return (tracee_label == 0 && self_label == 0) ||
        (tracee_label == 1 && self_label == 1 && tracee_length == self_length &&
         !memcmp(tracee, self, tracee_length));
}
/* Walk symlinks in the tracee's mount view, recording each repository link.
 * Never use realpath(/proc/PID/root/...): that can resolve against the host mount.
 */
static void resolve_name(pid_t pid, int fd, const char *input, int follow, char result[PATH_MAX]) {
    char pending[PATH_MAX], base[PATH_MAX];
    if (input[0] == '/') snprintf(pending, sizeof(pending), "%s", input);
    else {
        descriptor(pid, fd, base);
        if (base[0] != '/') { result[0] = 0; return; }
        if (snprintf(pending, sizeof(pending), "%s/%s", base, input) >= PATH_MAX) die("overlong relative path");
    }
    result[0] = 0;
    unsigned links = 0;
    while (*pending) {
        char *start = pending;
        while (*start == '/') start++;
        if (!*start) break;
        char *slash = strchr(start, '/');
        size_t length = slash ? (size_t)(slash - start) : strlen(start);
        char component[PATH_MAX], rest[PATH_MAX];
        memcpy(component, start, length);
        component[length] = 0;
        snprintf(rest, sizeof(rest), "%s", slash ? slash + 1 : "");
        if (!strcmp(component, ".")) {
            snprintf(pending, sizeof(pending), "%s", rest);
            continue;
        }
        if (!strcmp(component, "..")) {
            char *last = strrchr(result, '/');
            if (last) *last = 0;
            snprintf(pending, sizeof(pending), "%s", rest);
            continue;
        }
        size_t previous = strlen(result);
        if (previous + length + 2 > PATH_MAX) die("overlong resolved path");
        result[previous] = '/';
        memcpy(result + previous + 1, component, length + 1);
        char visible[PATH_MAX + 64];
        /* Magic self links are relative to the caller, not the observed task. */
        if (!strcmp(result, "/proc/self") || !strcmp(result, "/proc/thread-self")) {
            char status_path[96], line[4096];
            snprintf(status_path, sizeof(status_path), "/proc/%d/status", pid);
            FILE *status = fopen(status_path, "r");
            if (!status) die("tracee namespace identity unavailable");
            long namespace_pid = 0;
            while (fgets(line, sizeof(line), status)) if (!strncmp(line, "NSpid:", 6)) {
                char *cursor = line + 6, *end;
                for (;;) {
                    long value = strtol(cursor, &end, 10);
                    if (cursor == end) break;
                    namespace_pid = value;
                    cursor = end;
                }
            }
            fclose(status);
            if (!namespace_pid) die("tracee namespace identity missing");
            snprintf(result, PATH_MAX, "/proc/%ld", namespace_pid);
        }
        snprintf(visible, sizeof(visible), "/proc/%d/root%s", pid, result);
        struct stat info;
        int exists = lstat(visible, &info);
        if (exists < 0 && errno != ENOENT && errno != ENOTDIR) {
            if ((errno == EACCES || errno == EPERM) && !within(result) && same_access_context(pid)) {
                /* Matching filesystem credentials, capabilities and security
                 * label make this external denial apply to the tracee too.
                 * Confirm the syscall is denied before resuming it. */
                unresolved_external_permission = 1;
                result[0] = 0;
                return;
            }
            die("cannot inspect tracee path");
        }
        if ((!*rest && !follow) || exists < 0 || !S_ISLNK(info.st_mode)) {
            snprintf(pending, sizeof(pending), "%s", rest);
            continue;
        }
        capture(result, OBSERVE_CONTENTS);
        if (++links > 40) die("symlink resolution loop");
        char target[PATH_MAX];
        ssize_t size = readlink(visible, target, sizeof(target) - 1);
        if (size < 0) die("symlink changed during resolution");
        target[size] = 0;
        result[previous] = 0;
        if (target[0] == '/') result[0] = 0;
        if (snprintf(pending, sizeof(pending), "%s/%s", target, rest) >= PATH_MAX) die("overlong symlink target");
    }
    if (!*result) strcpy(result, "/");
}
static void resolve_path(pid_t pid, int fd, uint64_t address, int follow, char result[PATH_MAX]) {
    char input[PATH_MAX];
    if (!address || !trace_string(pid, address, input)) { result[0] = 0; return; }
    resolve_name(pid, fd, input, follow, result);
}

/* Kernel-loaded interpreters never issue a userspace open syscall. Inspect the
 * actual private executable, not its retained original, before allowing exec. */
static void executable(pid_t pid, const char *file, unsigned depth) {
    if (!*file) return;
    if (*file != '/' || strstr(file, " (deleted)")) die("anonymous or deleted executables are unsupported");
    if (depth > 5) die("executable interpreter recursion");
    capture(file, OBSERVE_CONTENTS);
    char visible[PATH_MAX + 64];
    snprintf(visible, sizeof(visible), "/proc/%d/root%s", pid, file);
    int fd = open(visible, O_RDONLY|O_NONBLOCK|O_CLOEXEC);
    if (fd < 0) {
        if (errno == ENOENT || errno == ENOTDIR) return;
        die("cannot inspect executable");
    }
    struct stat info;
    if (fstat(fd, &info)) die("cannot inspect executable identity");
    if (!S_ISREG(info.st_mode)) { close(fd); return; }
    unsigned char header[256] = {0};
    ssize_t count = pread(fd, header, sizeof(header), 0);
    if (count < 0) die("cannot read executable header");
    char interpreter[PATH_MAX] = {0};
    if (count >= 2 && header[0] == '#' && header[1] == '!') {
        size_t start = 2, end;
        while (start < (size_t)count && (header[start] == ' ' || header[start] == '\t')) start++;
        for (end = start; end < (size_t)count && header[end] && header[end] != '\n' && header[end] != ' ' && header[end] != '\t'; end++);
        if (end == sizeof(header)) die("overlong executable interpreter");
        memcpy(interpreter, header + start, end - start);
    } else if (count >= (ssize_t)sizeof(Elf64_Ehdr) && !memcmp(header, ELFMAG, SELFMAG)) {
        Elf64_Ehdr elf; memcpy(&elf, header, sizeof(elf));
#if defined(__x86_64__)
        if (elf.e_machine != EM_X86_64) die("foreign executable architecture is unsupported");
#elif defined(__aarch64__)
        if (elf.e_machine != EM_AARCH64) die("foreign executable architecture is unsupported");
#endif
        if (elf.e_ident[EI_CLASS] != ELFCLASS64 || elf.e_ident[EI_DATA] != ELFDATA2LSB ||
            elf.e_phentsize != sizeof(Elf64_Phdr) || elf.e_phnum == PN_XNUM)
            die("unsupported executable format");
        for (unsigned i = 0; i < elf.e_phnum; i++) {
            Elf64_Phdr entry;
            uint64_t offset = elf.e_phoff + (uint64_t)i * sizeof(entry);
            if (offset < elf.e_phoff || offset > (uint64_t)info.st_size ||
                pread(fd, &entry, sizeof(entry), offset) != sizeof(entry)) die("invalid executable program headers");
            if (entry.p_type != PT_INTERP) continue;
            if (*interpreter || entry.p_filesz < 2 || entry.p_filesz > sizeof(interpreter) ||
                entry.p_offset > (uint64_t)info.st_size ||
                pread(fd, interpreter, entry.p_filesz, entry.p_offset) != (ssize_t)entry.p_filesz ||
                interpreter[entry.p_filesz-1]) die("invalid executable interpreter");
        }
    } else {
        /* Do not silently permit a binfmt handler with unobserved dependencies. */
        die("unsupported executable format");
    }
    close(fd);
    if (*interpreter) {
        char resolved[PATH_MAX];
        resolve_name(pid, AT_FDCWD, interpreter, 1, resolved);
        executable(pid, resolved, depth + 1);
    }
}
static void path_access(pid_t pid, int fd, uint64_t address, int follow, char kind) {
    char file[PATH_MAX]; resolve_path(pid, fd, address, follow, file); capture(file, kind);
}
static void fd_access(pid_t pid, int fd, char kind) {
    char file[PATH_MAX]; descriptor(pid, fd, file); capture(file, kind);
}

/* Native ABIs only. The bypass mechanisms listed here return ENOSYS, allowing
 * libc/runtime fallbacks through observed operations. Unlisted syscalls are not
 * automatically classified; see the documented audited-coverage limitation. */
static const int denied[] = {
    SYS_io_uring_setup, SYS_io_uring_enter, SYS_io_uring_register,
    SYS_open_by_handle_at, SYS_name_to_handle_at, SYS_ptrace,
    SYS_process_vm_readv, SYS_process_vm_writev, SYS_pidfd_getfd,
};
static const int observed[] = {
    SYS_openat, SYS_openat2, SYS_newfstatat, SYS_statx, SYS_faccessat, SYS_faccessat2,
    SYS_readlinkat, SYS_unlinkat, SYS_renameat, SYS_renameat2, SYS_linkat, SYS_symlinkat,
    SYS_mkdirat, SYS_mknodat, SYS_fchmodat, SYS_fchownat, SYS_utimensat,
    SYS_getdents64, SYS_fstat, SYS_read, SYS_readv, SYS_pread64, SYS_preadv, SYS_preadv2,
    SYS_write, SYS_writev, SYS_pwrite64, SYS_pwritev, SYS_pwritev2, SYS_mmap,
    SYS_ftruncate, SYS_fchmod, SYS_fchown, SYS_copy_file_range, SYS_sendfile, SYS_splice,
    SYS_execve, SYS_execveat, SYS_clone, SYS_clone3, SYS_mount, SYS_umount2,
    SYS_pivot_root, SYS_chroot, SYS_setns, SYS_unshare, SYS_move_mount, SYS_open_tree,
    SYS_fsopen, SYS_fsconfig, SYS_fsmount, SYS_fspick,
    SYS_chdir, SYS_fchdir, SYS_ioctl, SYS_fallocate,
    SYS_getxattr, SYS_lgetxattr, SYS_fgetxattr, SYS_listxattr, SYS_llistxattr, SYS_flistxattr,
    SYS_setxattr, SYS_lsetxattr, SYS_fsetxattr, SYS_removexattr, SYS_lremovexattr, SYS_fremovexattr,
#ifdef SYS_fchmodat2
    SYS_fchmodat2,
#endif
#ifdef __x86_64__
    SYS_open, SYS_creat, SYS_stat, SYS_lstat, SYS_access, SYS_readlink, SYS_unlink,
    SYS_rename, SYS_link, SYS_symlink, SYS_mkdir, SYS_rmdir, SYS_mknod, SYS_chmod,
    SYS_chown, SYS_lchown, SYS_truncate, SYS_utime, SYS_utimes, SYS_futimesat, SYS_getdents,
#else
    SYS_truncate,
#endif
};
static void install_filter(void) {
    struct sock_filter rules[512]; size_t n = 0;
#define ADD(code, jt, jf, k) rules[n++] = (struct sock_filter){code, jt, jf, k}
    ADD(BPF_LD|BPF_W|BPF_ABS, 0, 0, offsetof(struct seccomp_data, arch));
#ifdef __x86_64__
    ADD(BPF_JMP|BPF_JEQ|BPF_K, 1, 0, AUDIT_ARCH_X86_64);
#elif defined(__aarch64__)
    ADD(BPF_JMP|BPF_JEQ|BPF_K, 1, 0, AUDIT_ARCH_AARCH64);
#else
#error Unsupported Linux observer architecture
#endif
    ADD(BPF_RET|BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
    ADD(BPF_LD|BPF_W|BPF_ABS, 0, 0, offsetof(struct seccomp_data, nr));
#ifdef __x86_64__
    ADD(BPF_JMP|BPF_JSET|BPF_K, 0, 1, 0x40000000); /* x32 shares the audit architecture */
    ADD(BPF_RET|BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS);
#endif
    for (size_t i = 0; i < sizeof(denied)/sizeof(*denied); i++) {
        ADD(BPF_JMP|BPF_JEQ|BPF_K, 0, 1, denied[i]);
        ADD(BPF_RET|BPF_K, 0, 0, SECCOMP_RET_ERRNO|ENOSYS);
    }
    for (size_t i = 0; i < sizeof(observed)/sizeof(*observed); i++) {
        ADD(BPF_JMP|BPF_JEQ|BPF_K, 0, 1, observed[i]);
        ADD(BPF_RET|BPF_K, 0, 0, SECCOMP_RET_TRACE);
    }
    ADD(BPF_RET|BPF_K, 0, 0, SECCOMP_RET_ALLOW);
    struct sock_fprog program = { n, rules };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) die("seccomp setup");
}

/* The first exec starts bwrap; the second starts the confined command. */
enum bootstrap_stage {
    COMMAND_RUNNING,
    BWRAP_RUNNING,
    BEFORE_BWRAP_EXEC,
};

/* Namespace bits accepted only while bubblewrap sets up its sandbox. */
static const uint64_t namespace_clone_flags =
    CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC |
    CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET;

struct task {
    pid_t pid;
    enum bootstrap_stage bootstrap;
    int alive;
    int initial_stop;
    int registered;
    int waiting;
    int checking_permission;
    struct task *next;
};
static struct task *tasks;
static struct task *task(pid_t pid) {
    for (struct task *t = tasks; t; t = t->next) {
        if (t->pid == pid) return t;
    }
    struct task *t = calloc(1, sizeof(*t));
    if (!t) die("task allocation");
    t->pid = pid;
    t->alive = 1;
    t->next = tasks;
    tasks = t;
    return t;
}
/* SIGKILL or a sibling's exec can retire a stopped thread before CONT. ESRCH
 * is not completion: retain the live record until wait reports its death or
 * an exec event explicitly identifies the replaced thread ID. */
static void resume_task(pid_t pid, int signal) {
    int request = task(pid)->checking_permission ? PTRACE_SYSCALL : PTRACE_CONT;
    if (ptrace(request, pid, 0, signal) && errno != ESRCH) die("trace resume failed");
}
static void syscall_entry(pid_t pid, struct ptrace_syscall_info *info) {
    __u64 *a = info->seccomp.args; long nr = info->seccomp.nr;
    enum bootstrap_stage bootstrap = task(pid)->bootstrap;
    if (nr == SYS_clone || nr == SYS_clone3) {
        uint64_t flags = a[0];
        if (nr == SYS_clone3) {
            errno = 0; flags = ptrace(PTRACE_PEEKDATA, pid, (void *)(uintptr_t)a[0], 0);
            if (errno) die("clone flags unavailable");
        }
        if (flags & CLONE_UNTRACED) die("CLONE_UNTRACED is unsupported");
        if (bootstrap == COMMAND_RUNNING && (flags & namespace_clone_flags))
            die("nested namespaces are unsupported");
        return;
    }
    if (nr == SYS_mount || nr == SYS_umount2 || nr == SYS_pivot_root || nr == SYS_chroot ||
        nr == SYS_setns || nr == SYS_unshare || nr == SYS_move_mount || nr == SYS_open_tree ||
        nr == SYS_fsopen || nr == SYS_fsconfig || nr == SYS_fsmount || nr == SYS_fspick) {
        if (!bootstrap) die("namespace changes are unsupported");
        return;
    }
    if (bootstrap != COMMAND_RUNNING &&
        !(bootstrap == BWRAP_RUNNING && (nr == SYS_execve || nr == SYS_execveat))) return;
    switch (nr) {
    case SYS_openat2: {
        /* IN_ROOT/BENEATH can change pathname interpretation. Reject resolve
         * modes until the observer implements their exact kernel semantics. */
        if (a[3] < 24) die("unsupported openat2 argument size");
        errno = 0;
        unsigned long resolve = ptrace(PTRACE_PEEKDATA, pid, (void *)(uintptr_t)(a[2] + 16), 0);
        if (errno || resolve) die("openat2 resolve modes are unsupported");
        path_access(pid, a[0], a[1], 1, OBSERVE_CONTENTS); break;
    }
    case SYS_openat: path_access(pid, a[0], a[1], 1, OBSERVE_CONTENTS); break;
    case SYS_newfstatat:
        if (!a[1] && (a[3]&AT_EMPTY_PATH)) fd_access(pid, a[0], OBSERVE_METADATA);
        else path_access(pid, a[0], a[1], !(a[3]&AT_SYMLINK_NOFOLLOW), OBSERVE_METADATA);
        break;
    case SYS_statx:
        if (!a[1] && (a[2]&AT_EMPTY_PATH)) fd_access(pid, a[0], OBSERVE_METADATA);
        else path_access(pid, a[0], a[1], !(a[2]&AT_SYMLINK_NOFOLLOW), OBSERVE_METADATA);
        break;
    case SYS_faccessat: case SYS_faccessat2: path_access(pid, a[0], a[1], 1, OBSERVE_METADATA); break;
    case SYS_readlinkat: path_access(pid, a[0], a[1], 0, OBSERVE_CONTENTS); break;
    case SYS_unlinkat: path_access(pid, a[0], a[1], 0, OBSERVE_TREE); break;
    case SYS_mkdirat: case SYS_mknodat: path_access(pid, a[0], a[1], 0, OBSERVE_CONTENTS); break;
    case SYS_utimensat:
        if (!a[1]) fd_access(pid, a[0], OBSERVE_CONTENTS); else path_access(pid, a[0], a[1], !(a[3]&AT_SYMLINK_NOFOLLOW), OBSERVE_CONTENTS); break;
#ifdef SYS_fchmodat2
    case SYS_fchmodat2:
#endif
    case SYS_fchmodat: case SYS_fchownat: path_access(pid, a[0], a[1], 1, OBSERVE_CONTENTS); break;
    case SYS_symlinkat: path_access(pid, a[1], a[2], 0, OBSERVE_CONTENTS); break;
    case SYS_linkat:
        path_access(pid, a[0], a[1], !!(a[4]&AT_SYMLINK_FOLLOW), OBSERVE_CONTENTS);
        path_access(pid, a[2], a[3], 0, OBSERVE_CONTENTS); break;
    case SYS_renameat: case SYS_renameat2: {
        char from[PATH_MAX], to[PATH_MAX];
        resolve_path(pid, a[0], a[1], 0, from); resolve_path(pid, a[2], a[3], 0, to);
        if (within(from) && within(to)) request(OBSERVE_RENAME, from+repository_length+1, to+repository_length+1);
        else { capture(from, OBSERVE_TREE); capture(to, OBSERVE_TREE); }
        break;
    }
    case SYS_getdents64: fd_access(pid, a[0], OBSERVE_DIRECTORY); break;
    case SYS_chdir: path_access(pid, AT_FDCWD, a[0], 1, OBSERVE_METADATA); break;
    case SYS_fchdir: fd_access(pid, a[0], OBSERVE_METADATA); break;
    case SYS_ioctl: {
        char file[PATH_MAX]; descriptor(pid, a[0], file);
        if (a[1] == FICLONE) { fd_access(pid, a[0], OBSERVE_CONTENTS); fd_access(pid, a[2], OBSERVE_CONTENTS); break; }
        if (within(file)) {
            if (a[1] == FIONBIO || a[1] == FIOCLEX || a[1] == FIONCLEX || a[1] == FIONREAD || a[1] == TCGETS) {
                capture(file, OBSERVE_METADATA); break;
            }
            char reason[128]; snprintf(reason, sizeof(reason), "unsupported repository ioctl 0x%llx", (unsigned long long)a[1]);
            die(reason);
        }
        break;
    }
    case SYS_getxattr: case SYS_listxattr: path_access(pid, AT_FDCWD, a[0], 1, OBSERVE_METADATA); break;
    case SYS_lgetxattr: case SYS_llistxattr: path_access(pid, AT_FDCWD, a[0], 0, OBSERVE_METADATA); break;
    case SYS_fgetxattr: case SYS_flistxattr: fd_access(pid, a[0], OBSERVE_METADATA); break;
    case SYS_setxattr: case SYS_removexattr: path_access(pid, AT_FDCWD, a[0], 1, OBSERVE_CONTENTS); break;
    case SYS_lsetxattr: case SYS_lremovexattr: path_access(pid, AT_FDCWD, a[0], 0, OBSERVE_CONTENTS); break;
    case SYS_fsetxattr: case SYS_fremovexattr: case SYS_fallocate: fd_access(pid, a[0], OBSERVE_CONTENTS); break;
    case SYS_fstat: fd_access(pid, a[0], OBSERVE_METADATA); break;
    case SYS_read: case SYS_readv: case SYS_pread64: case SYS_preadv: case SYS_preadv2:
    case SYS_write: case SYS_writev: case SYS_pwrite64: case SYS_pwritev: case SYS_pwritev2:
    case SYS_ftruncate: case SYS_fchmod: case SYS_fchown: fd_access(pid, a[0], OBSERVE_CONTENTS); break;
    case SYS_mmap: if (!(a[3]&MAP_ANONYMOUS)) fd_access(pid, a[4], OBSERVE_CONTENTS); break;
    case SYS_copy_file_range: case SYS_splice: fd_access(pid, a[0], OBSERVE_CONTENTS); fd_access(pid, a[2], OBSERVE_CONTENTS); break;
    case SYS_sendfile: fd_access(pid, a[0], OBSERVE_CONTENTS); fd_access(pid, a[1], OBSERVE_CONTENTS); break;
    case SYS_execve: case SYS_execveat: {
        char file[PATH_MAX];
        resolve_path(pid, nr == SYS_execve ? AT_FDCWD : (int)a[0], nr == SYS_execve ? a[0] : a[1], 1, file);
        executable(pid, file, 0); break;
    }
    case SYS_truncate: path_access(pid, AT_FDCWD, a[0], 1, OBSERVE_CONTENTS); break;
#ifdef __x86_64__
    case SYS_open: case SYS_creat: case SYS_chmod: case SYS_chown: case SYS_utime: case SYS_utimes:
        path_access(pid, AT_FDCWD, a[0], 1, OBSERVE_CONTENTS); break;
    case SYS_stat: case SYS_access: path_access(pid, AT_FDCWD, a[0], 1, OBSERVE_METADATA); break;
    case SYS_lstat: path_access(pid, AT_FDCWD, a[0], 0, OBSERVE_METADATA); break;
    case SYS_readlink: case SYS_lchown: case SYS_mkdir: case SYS_mknod:
        path_access(pid, AT_FDCWD, a[0], 0, OBSERVE_CONTENTS); break;
    case SYS_unlink: case SYS_rmdir: path_access(pid, AT_FDCWD, a[0], 0, OBSERVE_TREE); break;
    case SYS_symlink: path_access(pid, AT_FDCWD, a[1], 0, OBSERVE_CONTENTS); break;
    case SYS_link: path_access(pid, AT_FDCWD, a[0], 0, OBSERVE_CONTENTS); path_access(pid, AT_FDCWD, a[1], 0, OBSERVE_CONTENTS); break;
    case SYS_rename: {
        char from[PATH_MAX], to[PATH_MAX];
        resolve_path(pid, AT_FDCWD, a[0], 0, from); resolve_path(pid, AT_FDCWD, a[1], 0, to);
        if (within(from) && within(to)) request(OBSERVE_RENAME, from+repository_length+1, to+repository_length+1);
        else { capture(from, OBSERVE_TREE); capture(to, OBSERVE_TREE); }
        break;
    }
    case SYS_futimesat: path_access(pid, a[0], a[1], 1, OBSERVE_CONTENTS); break;
    case SYS_getdents: fd_access(pid, a[0], OBSERVE_DIRECTORY); break;
#endif
    default: die("unclassified filesystem syscall");
    }
}

static void descendant_event(pid_t parent) {
    unsigned long child;
    if (ptrace(PTRACE_GETEVENTMSG, parent, 0, &child)) die("missing descendant");

    struct task *descendant = task(child);
    descendant->bootstrap = task(parent)->bootstrap;
    descendant->alive = 1;
    descendant->registered = 1;
    if (descendant->waiting) {
        descendant->waiting = 0;
        resume_task(child, 0);
    } else {
        descendant->initial_stop = 1;
    }
}

static void exec_event(pid_t pid) {
    unsigned long former;
    if (ptrace(PTRACE_GETEVENTMSG, pid, 0, &former)) die("missing exec thread identity");
    struct task *current = task(pid);
    if (current->checking_permission || (former != (unsigned long)pid && task(former)->checking_permission))
        die("unresolved external path was executed");
    if (former != (unsigned long)pid) {
        current->bootstrap = task(former)->bootstrap;
        task(former)->alive = 0;
    }
    current->alive = 1;
    if (current->bootstrap != COMMAND_RUNNING) current->bootstrap--;
}

static int initial_stop_event(pid_t pid) {
    struct task *current = task(pid);
    if (!current->registered) {
        current->waiting = 1;
        return 0;
    }
    if (!current->initial_stop && !stopping)
        die("explicit process group stops are unsupported");
    current->initial_stop = 0;
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 6) { fprintf(stderr, "usage: observer socket token repository bwrap ...\n"); return 125; }
    repository = argv[3]; repository_length = strlen(repository);
    broker = socket(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0);
    if (broker < 0) die("broker socket");
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (strlen(argv[1]) >= sizeof(address.sun_path)) die("broker socket path too long");
    strcpy(address.sun_path, argv[1]);
    if (connect(broker, (struct sockaddr *)&address, sizeof(address))) die("broker connect");
    request(OBSERVE_HELLO, argv[2], "");
    memset(argv[2], 0, strlen(argv[2]));
    if (prctl(PR_SET_DUMPABLE, 0)) die("protect observer state");
    initial = fork();
    if (initial < 0) die("fork");
    if (!initial) {
        close(broker);
        if (prctl(PR_SET_DUMPABLE, 1) || ptrace(PTRACE_TRACEME, 0, 0, 0)) die("ptrace setup");
        raise(SIGSTOP);
        install_filter();
        execvp(argv[4], argv+4);
        die("exec bubblewrap");
    }
    int status, exit_code = 125;
    if (waitpid(initial, &status, 0) != initial || !WIFSTOPPED(status)) die("initial trace stop");
    long flags = PTRACE_O_TRACEFORK|PTRACE_O_TRACEVFORK|PTRACE_O_TRACECLONE|PTRACE_O_TRACEEXEC|
        PTRACE_O_TRACESECCOMP|PTRACE_O_TRACESYSGOOD|PTRACE_O_EXITKILL;
    if (ptrace(PTRACE_SETOPTIONS, initial, 0, flags)) die("ptrace options");
    task(initial)->bootstrap = BEFORE_BWRAP_EXEC;
    task(initial)->registered = 1;
    struct sigaction stop = { .sa_handler = stop_requested };
    sigemptyset(&stop.sa_mask);
    if (sigaction(SIGTERM, &stop, 0) || sigaction(SIGINT, &stop, 0)) die("termination handler setup");
    if (ptrace(PTRACE_CONT, initial, 0, 0)) die("initial resume");
    for (;;) {
        if (stopping) {
            for (struct task *t = tasks; t; t = t->next) if (t->alive) kill(t->pid, SIGKILL);
        }
        pid_t pid = waitpid(-1, &status, __WALL);
        if (pid < 0) {
            if (errno == EINTR) continue;
            if (errno == ECHILD) {
                for (struct task *t = tasks; t; t = t->next)
                    if (t->alive) die("trace ended without confirmed task completion");
                break;
            }
            die("trace wait");
        }
        if (WIFEXITED(status) || WIFSIGNALED(status)) {
            task(pid)->alive = 0;
            if (pid == initial)
                exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128+WTERMSIG(status);
            continue;
        }
        if (!WIFSTOPPED(status)) die("unexpected process state");
        int event = (unsigned)status >> 16, signal = WSTOPSIG(status);
        if (event == PTRACE_EVENT_SECCOMP) {
            struct ptrace_syscall_info info;
            if (ptrace(PTRACE_GET_SYSCALL_INFO, pid, sizeof(info), &info) < 0 || info.op != PTRACE_SYSCALL_INFO_SECCOMP)
                die("syscall information unavailable");
            unresolved_external_permission = 0;
            syscall_entry(pid, &info);
            if (unresolved_external_permission) task(pid)->checking_permission = 1;
            signal = 0;
        } else if (signal == (SIGTRAP|0x80) && task(pid)->checking_permission) {
            struct ptrace_syscall_info info;
            if (ptrace(PTRACE_GET_SYSCALL_INFO, pid, sizeof(info), &info) < 0)
                die("unresolved external path result unavailable");
            if (info.op == PTRACE_SYSCALL_INFO_EXIT) {
                if (info.exit.rval != -EACCES && info.exit.rval != -EPERM)
                    die("unresolved external path was accessed");
                task(pid)->checking_permission = 0;
            } else if (info.op != PTRACE_SYSCALL_INFO_ENTRY) {
                die("unresolved external path result unavailable");
            }
            signal = 0;
        } else if (event == PTRACE_EVENT_FORK || event == PTRACE_EVENT_VFORK || event == PTRACE_EVENT_CLONE) {
            descendant_event(pid);
            signal = 0;
        } else if (event == PTRACE_EVENT_EXEC) {
            exec_event(pid);
            signal = 0;
        } else if (signal == SIGSTOP) {
            if (!initial_stop_event(pid)) continue;
            signal = 0;
        }
        resume_task(pid, signal);
    }
    request(OBSERVE_FINISHED, "", "");
    close(broker);
    return exit_code;
}
