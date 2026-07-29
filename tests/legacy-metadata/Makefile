staging_dir/host/.prereq-build: include/prereq-build.mk
	@echo "obsolete host-version gate was executed" >&2
	@false

defconfig: staging_dir/host/.prereq-build
	@mkdir -p tmp
	@printf 'Target: fixture\n' > tmp/.targetinfo
	@printf 'Package: fixture\n' > tmp/.packageinfo
